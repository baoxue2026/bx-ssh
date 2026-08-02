use std::path::Path;
use std::sync::Arc;

use bx_contracts::HostKeyInfo;
use russh::client;
use russh::keys::{self, ssh_key, HashAlg, PrivateKeyWithHashAlg};
use tokio::sync::Mutex;
use tokio::time;

use crate::{HostFingerprint, SshEndpoint, SshError};

#[derive(Clone)]
struct HostKeyVerifier {
    expected: Option<HostFingerprint>,
    observed: Arc<Mutex<Option<HostKeyInfo>>>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let host_key = HostKeyInfo::new(
            server_public_key.algorithm().to_string(),
            server_public_key.fingerprint(HashAlg::Sha256).to_string(),
        );
        let accepted = self
            .expected
            .as_ref()
            .is_none_or(|expected| expected.as_str() == host_key.fingerprint_sha256);

        *self.observed.lock().await = Some(host_key);
        Ok(accepted)
    }
}

pub struct ClientSession {
    handle: client::Handle<HostKeyVerifier>,
    host_key: HostKeyInfo,
}

impl ClientSession {
    pub fn host_key(&self) -> &HostKeyInfo {
        &self.host_key
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await?;
        Ok(())
    }
}

pub async fn probe_host_key(endpoint: &SshEndpoint) -> Result<HostKeyInfo, SshError> {
    let (handle, host_key) = connect(endpoint, None).await?;
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await?;
    Ok(host_key)
}

pub async fn authenticate_password(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    password: &str,
) -> Result<ClientSession, SshError> {
    validate_username(username)?;
    let fingerprint = HostFingerprint::parse(expected_fingerprint)?;
    let (mut handle, host_key) = connect(endpoint, Some(fingerprint)).await?;

    let result = time::timeout(
        endpoint.operation_timeout(),
        handle.authenticate_password(username, password),
    )
    .await
    .map_err(|_| SshError::AuthenticationTimeout)??;

    if !result.success() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        return Err(SshError::AuthenticationRejected { method: "password" });
    }

    Ok(ClientSession { handle, host_key })
}

pub async fn authenticate_private_key(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    private_key_path: impl AsRef<Path>,
    passphrase: Option<&str>,
) -> Result<ClientSession, SshError> {
    validate_username(username)?;
    let fingerprint = HostFingerprint::parse(expected_fingerprint)?;
    let private_key = keys::load_secret_key(private_key_path, passphrase)?;
    let (mut handle, host_key) = connect(endpoint, Some(fingerprint)).await?;

    let result = time::timeout(endpoint.operation_timeout(), async {
        let hash_algorithm = if private_key.algorithm().is_rsa() {
            match handle.best_supported_rsa_hash().await? {
                Some(Some(hash_algorithm)) => Some(hash_algorithm),
                Some(None) => return Err(SshError::LegacyRsaSignatureOnly),
                None => Some(HashAlg::Sha256),
            }
        } else {
            None
        };

        handle
            .authenticate_publickey(
                username,
                PrivateKeyWithHashAlg::new(Arc::new(private_key), hash_algorithm),
            )
            .await
            .map_err(SshError::from)
    })
    .await
    .map_err(|_| SshError::AuthenticationTimeout)??;

    if !result.success() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        return Err(SshError::AuthenticationRejected {
            method: "private key",
        });
    }

    Ok(ClientSession { handle, host_key })
}

async fn connect(
    endpoint: &SshEndpoint,
    expected: Option<HostFingerprint>,
) -> Result<(client::Handle<HostKeyVerifier>, HostKeyInfo), SshError> {
    let observed = Arc::new(Mutex::new(None));
    let handler = HostKeyVerifier {
        expected: expected.clone(),
        observed: Arc::clone(&observed),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(endpoint.operation_timeout()),
        nodelay: true,
        ..Default::default()
    });

    let result = time::timeout(
        endpoint.connect_timeout(),
        client::connect(config, (endpoint.host(), endpoint.port()), handler),
    )
    .await
    .map_err(|_| SshError::ConnectTimeout)?;

    let handle = match result {
        Ok(handle) => handle,
        Err(russh::Error::UnknownKey) => {
            let actual = observed
                .lock()
                .await
                .clone()
                .ok_or(SshError::HostKeyUnavailable)?;
            if let Some(expected) = expected {
                return Err(SshError::HostKeyMismatch {
                    expected: expected.to_string(),
                    actual: actual.fingerprint_sha256,
                });
            }
            return Err(SshError::Transport(russh::Error::UnknownKey));
        }
        Err(error) => return Err(SshError::Transport(error)),
    };

    let host_key = observed
        .lock()
        .await
        .clone()
        .ok_or(SshError::HostKeyUnavailable)?;
    Ok((handle, host_key))
}

fn validate_username(username: &str) -> Result<(), SshError> {
    if username.trim().is_empty() {
        Err(SshError::InvalidUsername)
    } else {
        Ok(())
    }
}
