use std::borrow::Cow;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use bx_contracts::{HostKeyInfo, SshConnectionStage};
use russh::client;
use russh::keys::{self, ssh_key, HashAlg, PrivateKeyWithHashAlg};
use tokio::net::{lookup_host, TcpStream};
use tokio::sync::{watch, Mutex};
use tokio::time;

use crate::algorithms::preferred_algorithms;
use crate::{
    HostFingerprint, SftpClient, SshEndpoint, SshError, SshNegotiatedAlgorithms, SshShell,
    TerminalSize,
};

#[derive(Clone)]
pub struct ConnectionCancellation {
    sender: watch::Sender<bool>,
}

impl Default for ConnectionCancellation {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }
}

impl ConnectionCancellation {
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow_and_update() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow_and_update() {
                return;
            }
        }
    }
}

#[derive(Clone)]
struct HostKeyVerifier {
    expected: Option<HostFingerprint>,
    observed: Arc<Mutex<Option<HostKeyInfo>>>,
    negotiated: Arc<Mutex<Option<SshNegotiatedAlgorithms>>>,
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

    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &russh::Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        *self.negotiated.lock().await = Some(SshNegotiatedAlgorithms::from_names(names));
        Ok(())
    }
}

pub struct ClientSession {
    handle: client::Handle<HostKeyVerifier>,
    host_key: HostKeyInfo,
    negotiated_algorithms: SshNegotiatedAlgorithms,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardInteractivePrompt {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KeyboardInteractivePromptItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardInteractivePromptItem {
    pub prompt: String,
    pub echo: bool,
}

impl ClientSession {
    pub fn host_key(&self) -> &HostKeyInfo {
        &self.host_key
    }

    pub fn negotiated_algorithms(&self) -> &SshNegotiatedAlgorithms {
        &self.negotiated_algorithms
    }

    pub async fn open_shell(&self, size: TerminalSize) -> Result<SshShell, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(SshError::ChannelOpenFailed)?;
        SshShell::open(channel, size).await
    }

    pub async fn open_sftp(&self) -> Result<SftpClient, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(SshError::ChannelOpenFailed)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(SshError::ChannelOpenFailed)?;
        SftpClient::open(channel.into_stream()).await
    }

    pub async fn wait_for_transport(&mut self) -> Result<(), SshError> {
        (&mut self.handle).await.map_err(SshError::from)
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await?;
        Ok(())
    }
}

pub async fn probe_host_key(endpoint: &SshEndpoint) -> Result<HostKeyInfo, SshError> {
    let cancellation = ConnectionCancellation::default();
    let (handle, host_key, _) = connect(endpoint, None, &cancellation, &mut |_| {}).await?;
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
    authenticate_password_with_progress(
        endpoint,
        username,
        expected_fingerprint,
        password,
        &ConnectionCancellation::default(),
        |_| {},
    )
    .await
}

pub async fn authenticate_password_with_progress<F>(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    password: &str,
    cancellation: &ConnectionCancellation,
    mut on_stage: F,
) -> Result<ClientSession, SshError>
where
    F: FnMut(SshConnectionStage),
{
    validate_username(username)?;
    let fingerprint = HostFingerprint::parse(expected_fingerprint)?;
    let (mut handle, host_key, negotiated_algorithms) =
        connect(endpoint, Some(fingerprint), cancellation, &mut on_stage).await?;

    on_stage(SshConnectionStage::Authenticating);

    let authentication = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
            return Err(SshError::ConnectionCancelled);
        }
        result = time::timeout(
            endpoint.operation_timeout(),
            handle.authenticate_password(username, password),
        ) => result,
    };
    let result = match authentication {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            return Err(SshError::AuthenticationFailed(error));
        }
        Err(_) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            return Err(SshError::AuthenticationTimeout);
        }
    };

    if !result.success() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        return Err(SshError::AuthenticationRejected { method: "password" });
    }

    Ok(ClientSession {
        handle,
        host_key,
        negotiated_algorithms,
    })
}

/// Authenticate using SSH keyboard-interactive (RFC 4256) prompts.
///
/// The callback is invoked once for every server prompt round. Answers are
/// supplied by the caller and are never logged or retained by this crate.
pub async fn authenticate_keyboard_interactive_with_progress<F, Fut>(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    cancellation: &ConnectionCancellation,
    mut on_prompt: F,
    mut on_stage: impl FnMut(SshConnectionStage),
) -> Result<ClientSession, SshError>
where
    F: FnMut(KeyboardInteractivePrompt) -> Fut,
    Fut: Future<Output = Result<Vec<String>, SshError>>,
{
    validate_username(username)?;
    let fingerprint = HostFingerprint::parse(expected_fingerprint)?;
    let (mut handle, host_key, negotiated_algorithms) =
        connect(endpoint, Some(fingerprint), cancellation, &mut on_stage).await?;

    on_stage(SshConnectionStage::Authenticating);
    let reply = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
            return Err(SshError::ConnectionCancelled);
        }
        result = time::timeout(
            endpoint.operation_timeout(),
            handle.authenticate_keyboard_interactive_start(username, None::<String>),
        ) => result,
    };
    let mut reply = match reply {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            return Err(SshError::AuthenticationFailed(error));
        }
        Err(_) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            return Err(SshError::AuthenticationTimeout);
        }
    };

    loop {
        let response = match reply {
            russh::client::KeyboardInteractiveAuthResponse::Success => break,
            russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "")
                    .await;
                return Err(SshError::AuthenticationRejected {
                    method: "keyboard-interactive",
                });
            }
            russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let prompt = KeyboardInteractivePrompt {
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|item| KeyboardInteractivePromptItem {
                            prompt: item.prompt,
                            echo: item.echo,
                        })
                        .collect(),
                };
                let answers = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
                        return Err(SshError::ConnectionCancelled);
                    }
                    answers = on_prompt(prompt) => answers,
                };
                match answers {
                    Ok(answers) => answers,
                    Err(error) => {
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "", "")
                            .await;
                        return Err(error);
                    }
                }
            }
        };

        let next_reply = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
                return Err(SshError::ConnectionCancelled);
            }
            result = time::timeout(
                endpoint.operation_timeout(),
                handle.authenticate_keyboard_interactive_respond(response),
            ) => result,
        };
        reply = match next_reply {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "")
                    .await;
                return Err(SshError::AuthenticationFailed(error));
            }
            Err(_) => {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "")
                    .await;
                return Err(SshError::AuthenticationTimeout);
            }
        };
    }

    Ok(ClientSession {
        handle,
        host_key,
        negotiated_algorithms,
    })
}

pub async fn authenticate_private_key(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    private_key_path: impl AsRef<Path>,
    passphrase: Option<&str>,
) -> Result<ClientSession, SshError> {
    authenticate_private_key_with_progress(
        endpoint,
        username,
        expected_fingerprint,
        private_key_path,
        passphrase,
        &ConnectionCancellation::default(),
        |_| {},
    )
    .await
}

pub async fn authenticate_private_key_with_progress<F>(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    private_key_path: impl AsRef<Path>,
    passphrase: Option<&str>,
    cancellation: &ConnectionCancellation,
    mut on_stage: F,
) -> Result<ClientSession, SshError>
where
    F: FnMut(SshConnectionStage),
{
    validate_username(username)?;
    let private_key = keys::load_secret_key(private_key_path, passphrase)?;
    authenticate_loaded_private_key(
        endpoint,
        username,
        expected_fingerprint,
        private_key,
        cancellation,
        &mut on_stage,
    )
    .await
}

/// Authenticate using private-key contents already loaded by the Rust desktop
/// layer. The contents never need to cross the WebView boundary.
pub async fn authenticate_private_key_contents_with_progress<F>(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    private_key_contents: &str,
    passphrase: Option<&str>,
    cancellation: &ConnectionCancellation,
    mut on_stage: F,
) -> Result<ClientSession, SshError>
where
    F: FnMut(SshConnectionStage),
{
    validate_username(username)?;
    let private_key = keys::decode_secret_key(private_key_contents, passphrase)?;
    authenticate_loaded_private_key(
        endpoint,
        username,
        expected_fingerprint,
        private_key,
        cancellation,
        &mut on_stage,
    )
    .await
}

async fn authenticate_loaded_private_key(
    endpoint: &SshEndpoint,
    username: &str,
    expected_fingerprint: &str,
    private_key: keys::PrivateKey,
    cancellation: &ConnectionCancellation,
    on_stage: &mut impl FnMut(SshConnectionStage),
) -> Result<ClientSession, SshError> {
    let fingerprint = HostFingerprint::parse(expected_fingerprint)?;
    let (mut handle, host_key, negotiated_algorithms) =
        connect(endpoint, Some(fingerprint), cancellation, on_stage).await?;

    on_stage(SshConnectionStage::Authenticating);
    let authentication = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
            return Err(SshError::ConnectionCancelled);
        }
        result = time::timeout(endpoint.operation_timeout(), async {
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
        }) => result,
    };
    let result = match authentication {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            return Err(error);
        }
        Err(_) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
            return Err(SshError::AuthenticationTimeout);
        }
    };

    if !result.success() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        return Err(SshError::AuthenticationRejected {
            method: "private key",
        });
    }

    Ok(ClientSession {
        handle,
        host_key,
        negotiated_algorithms,
    })
}

async fn connect(
    endpoint: &SshEndpoint,
    expected: Option<HostFingerprint>,
    cancellation: &ConnectionCancellation,
    on_stage: &mut impl FnMut(SshConnectionStage),
) -> Result<
    (
        client::Handle<HostKeyVerifier>,
        HostKeyInfo,
        SshNegotiatedAlgorithms,
    ),
    SshError,
> {
    let deadline = time::Instant::now() + endpoint.connect_timeout();

    on_stage(SshConnectionStage::ResolvingDns);
    let lookup = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(SshError::ConnectionCancelled),
        result = time::timeout_at(
            deadline,
            lookup_host((endpoint.host(), endpoint.port())),
        ) => result,
    };
    let addresses = lookup
        .map_err(|_| SshError::DnsLookupTimeout)?
        .map_err(SshError::DnsLookupFailed)?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(SshError::DnsLookupFailed(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "DNS lookup returned no addresses",
        )));
    }

    on_stage(SshConnectionStage::ConnectingTcp);
    let socket = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(SshError::ConnectionCancelled),
        result = time::timeout_at(
            deadline,
            TcpStream::connect(addresses.as_slice()),
        ) => result,
    }
    .map_err(|_| SshError::TcpConnectTimeout)?
    .map_err(classify_tcp_error)?;
    let _ = socket.set_nodelay(true);

    on_stage(SshConnectionStage::Handshaking);
    let observed = Arc::new(Mutex::new(None));
    let negotiated = Arc::new(Mutex::new(None));
    let handler = HostKeyVerifier {
        expected: expected.clone(),
        observed: Arc::clone(&observed),
        negotiated: Arc::clone(&negotiated),
    };
    let config = Arc::new(client_config(endpoint));

    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(SshError::ConnectionCancelled),
        result = time::timeout_at(
            deadline,
            client::connect_stream(config, socket, handler),
        ) => result,
    }
    .map_err(|_| SshError::HandshakeTimeout)?;

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
            return Err(SshError::HandshakeFailed(russh::Error::UnknownKey));
        }
        Err(error) => return Err(SshError::HandshakeFailed(error)),
    };

    let host_key = observed
        .lock()
        .await
        .clone()
        .ok_or(SshError::HostKeyUnavailable)?;
    let negotiated_algorithms = negotiated
        .lock()
        .await
        .clone()
        .ok_or(SshError::NegotiatedAlgorithmsUnavailable)?;
    Ok((handle, host_key, negotiated_algorithms))
}

fn classify_tcp_error(error: std::io::Error) -> SshError {
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => SshError::ConnectionRefused(error),
        std::io::ErrorKind::NetworkUnreachable
        | std::io::ErrorKind::HostUnreachable
        | std::io::ErrorKind::AddrNotAvailable => SshError::NetworkUnreachable(error),
        std::io::ErrorKind::TimedOut => SshError::TcpConnectTimeout,
        _ => SshError::TcpConnectFailed(error),
    }
}

fn client_config(endpoint: &SshEndpoint) -> client::Config {
    client::Config {
        client_id: russh::SshId::Standard(Cow::Borrowed(concat!(
            "SSH-2.0-BX_SSH_",
            env!("CARGO_PKG_VERSION")
        ))),
        preferred: preferred_algorithms(),
        inactivity_timeout: None,
        keepalive_interval: endpoint.keep_alive_interval(),
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

    use super::{classify_tcp_error, client_config, probe_host_key, ConnectionCancellation};
    use crate::{SshEndpoint, SshError};
    use tokio::time;

    #[test]
    fn uses_the_product_ssh_identification() {
        let endpoint = SshEndpoint::new("example.com", 22).unwrap();
        let config = client_config(&endpoint);

        match config.client_id {
            russh::SshId::Standard(identifier) => {
                assert_eq!(
                    identifier,
                    concat!("SSH-2.0-BX_SSH_", env!("CARGO_PKG_VERSION"))
                );
            }
            russh::SshId::Raw(_) => panic!("product SSH identification must use standard framing"),
        }
    }

    #[tokio::test]
    async fn observes_cancellation_requested_before_waiting() {
        let cancellation = ConnectionCancellation::default();
        cancellation.cancel();

        time::timeout(Duration::from_millis(50), cancellation.cancelled())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn wakes_all_connection_cancellation_waiters() {
        let cancellation = ConnectionCancellation::default();
        let first = tokio::spawn({
            let cancellation = cancellation.clone();
            async move { cancellation.cancelled().await }
        });
        let second = tokio::spawn({
            let cancellation = cancellation.clone();
            async move { cancellation.cancelled().await }
        });

        tokio::task::yield_now().await;
        cancellation.cancel();
        time::timeout(Duration::from_millis(50), async {
            first.await.unwrap();
            second.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[test]
    fn keeps_idle_sessions_alive_and_detects_unresponsive_servers() {
        let endpoint = SshEndpoint::new("ssh.example.com", 22)
            .unwrap()
            .with_keep_alive_interval(Some(Duration::from_secs(45)));

        let config = client_config(&endpoint);

        assert_eq!(config.inactivity_timeout, None);
        assert_eq!(config.keepalive_interval, Some(Duration::from_secs(45)));
        assert_eq!(config.keepalive_max, 3);
        assert!(config.nodelay);
    }

    #[test]
    fn allows_keep_alive_to_be_disabled() {
        let endpoint = SshEndpoint::new("ssh.example.com", 22)
            .unwrap()
            .with_keep_alive_interval(None);

        assert_eq!(client_config(&endpoint).keepalive_interval, None);
    }

    #[test]
    fn classifies_tcp_connection_errors() {
        let refused =
            classify_tcp_error(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        let unreachable =
            classify_tcp_error(std::io::Error::from(std::io::ErrorKind::HostUnreachable));
        let timed_out = classify_tcp_error(std::io::Error::from(std::io::ErrorKind::TimedOut));

        assert!(matches!(refused, SshError::ConnectionRefused(_)));
        assert!(matches!(unreachable, SshError::NetworkUnreachable(_)));
        assert!(matches!(timed_out, SshError::TcpConnectTimeout));
    }

    #[tokio::test]
    async fn applies_the_connect_deadline_to_the_ssh_handshake() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            time::sleep(Duration::from_secs(1)).await;
        });
        let endpoint = SshEndpoint::new("127.0.0.1", port)
            .unwrap()
            .with_connect_timeout(Duration::from_millis(50));
        let started = time::Instant::now();

        let error = probe_host_key(&endpoint).await.unwrap_err();

        assert!(matches!(error, SshError::HandshakeTimeout));
        assert!(started.elapsed() < Duration::from_millis(500));
        server.abort();
    }
}
