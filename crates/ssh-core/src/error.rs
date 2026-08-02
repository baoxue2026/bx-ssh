use thiserror::Error;

#[derive(Debug, Error)]
pub enum SshError {
    #[error("SSH host must not be empty")]
    InvalidHost,
    #[error("SSH port must be between 1 and 65535")]
    InvalidPort,
    #[error("SSH username must not be empty")]
    InvalidUsername,
    #[error("host fingerprint must be an OpenSSH SHA-256 fingerprint")]
    InvalidFingerprint,
    #[error("SSH connection timed out")]
    ConnectTimeout,
    #[error("SSH authentication timed out")]
    AuthenticationTimeout,
    #[error("server did not provide a host key")]
    HostKeyUnavailable,
    #[error("server host key changed: expected {expected}, received {actual}")]
    HostKeyMismatch { expected: String, actual: String },
    #[error("{method} authentication was rejected")]
    AuthenticationRejected { method: &'static str },
    #[error("server only offered the legacy SHA-1 RSA signature")]
    LegacyRsaSignatureOnly,
    #[error("terminal columns and rows must be greater than zero")]
    InvalidTerminalSize,
    #[error("{request} request was rejected by the SSH server")]
    ChannelRequestRejected { request: &'static str },
    #[error("SSH channel closed while waiting for the {request} response")]
    ChannelClosed { request: &'static str },
    #[error("failed to load private key: {0}")]
    PrivateKey(#[from] russh::keys::Error),
    #[error("SSH transport failed: {0}")]
    Transport(#[from] russh::Error),
}
