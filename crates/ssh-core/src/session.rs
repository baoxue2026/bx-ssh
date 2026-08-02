use std::path::Path;
use std::sync::Arc;

use bx_contracts::HostKeyInfo;
use russh::client;
use russh::keys::{self, ssh_key, HashAlg, PrivateKeyWithHashAlg};
use tokio::sync::Mutex;
use tokio::time;

use crate::{HostFingerprint, SshEndpoint, SshError, SshShell, TerminalSize};

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

    pub async fn open_shell(&self, size: TerminalSize) -> Result<SshShell, SshError> {
        let channel = self.handle.channel_open_session().await?;
        SshShell::open(channel, size).await
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
    let config = Arc::new(client_config(endpoint));

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

fn client_config(endpoint: &SshEndpoint) -> client::Config {
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(endpoint.operation_timeout()),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    }
}

fn validate_username(username: &str) -> Result<(), SshError> {
    if username.trim().is_empty() {
        Err(SshError::InvalidUsername)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::client_config;
    use crate::SshEndpoint;

    #[test]
    fn keeps_idle_sessions_alive_and_detects_unresponsive_servers() {
        let endpoint = SshEndpoint::new("ssh.example.com", 22)
            .unwrap()
            .with_operation_timeout(Duration::from_secs(45));

        let config = client_config(&endpoint);

        assert_eq!(config.inactivity_timeout, None);
        assert_eq!(config.keepalive_interval, Some(Duration::from_secs(45)));
        assert_eq!(config.keepalive_max, 3);
        assert!(config.nodelay);
    }
}
