use thiserror::Error;

use bx_contracts::SshConnectionStage;

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
    #[error("SSH DNS lookup timed out")]
    DnsLookupTimeout,
    #[error("SSH DNS lookup failed: {0}")]
    DnsLookupFailed(#[source] std::io::Error),
    #[error("SSH TCP connection timed out")]
    TcpConnectTimeout,
    #[error("SSH TCP connection failed: {0}")]
    TcpConnectFailed(#[source] std::io::Error),
    #[error("SSH handshake timed out")]
    HandshakeTimeout,
    #[error("SSH handshake failed: {0}")]
    HandshakeFailed(#[source] russh::Error),
    #[error("SSH handshake did not report the negotiated algorithms")]
    NegotiatedAlgorithmsUnavailable,
    #[error("SSH connection was cancelled")]
    ConnectionCancelled,
    #[error("SSH authentication timed out")]
    AuthenticationTimeout,
    #[error("SSH authentication failed: {0}")]
    AuthenticationFailed(#[source] russh::Error),
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
    #[error("remote SFTP path must not be empty or contain a null byte")]
    InvalidRemotePath,
    #[error("local transfer path must reference a regular file")]
    InvalidLocalFile,
    #[error("local transfer target already exists")]
    LocalTargetExists,
    #[error("remote transfer target already exists")]
    RemoteTargetExists,
    #[error("file transfer integrity check failed: expected {expected}, received {actual}")]
    TransferIntegrityMismatch { expected: String, actual: String },
    #[error("{request} request was rejected by the SSH server")]
    ChannelRequestRejected { request: &'static str },
    #[error("SSH channel closed while waiting for the {request} response")]
    ChannelClosed { request: &'static str },
    #[error("SSH channel could not be opened: {0}")]
    ChannelOpenFailed(#[source] russh::Error),
    #[error("failed to load private key: {0}")]
    PrivateKey(#[from] russh::keys::Error),
    #[error("SFTP operation failed: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("file transfer I/O failed: {0}")]
    TransferIo(#[from] std::io::Error),
    #[error("SSH transport failed: {0}")]
    Transport(#[from] russh::Error),
}

impl SshError {
    pub fn connection_stage(&self) -> Option<SshConnectionStage> {
        use SshConnectionStage::{
            Authenticating, ConnectingTcp, Handshaking, OpeningChannel, ResolvingDns,
        };

        match self {
            Self::DnsLookupTimeout | Self::DnsLookupFailed(_) => Some(ResolvingDns),
            Self::ConnectTimeout | Self::TcpConnectTimeout | Self::TcpConnectFailed(_) => {
                Some(ConnectingTcp)
            }
            Self::HandshakeTimeout
            | Self::HandshakeFailed(_)
            | Self::NegotiatedAlgorithmsUnavailable
            | Self::HostKeyUnavailable
            | Self::HostKeyMismatch { .. } => Some(Handshaking),
            Self::InvalidUsername
            | Self::AuthenticationTimeout
            | Self::AuthenticationFailed(_)
            | Self::AuthenticationRejected { .. }
            | Self::LegacyRsaSignatureOnly
            | Self::PrivateKey(_) => Some(Authenticating),
            Self::ChannelRequestRejected { .. }
            | Self::ChannelClosed { .. }
            | Self::ChannelOpenFailed(_) => Some(OpeningChannel),
            Self::InvalidHost
            | Self::InvalidPort
            | Self::InvalidFingerprint
            | Self::ConnectionCancelled
            | Self::InvalidTerminalSize
            | Self::InvalidRemotePath
            | Self::InvalidLocalFile
            | Self::LocalTargetExists
            | Self::RemoteTargetExists
            | Self::TransferIntegrityMismatch { .. }
            | Self::Sftp(_)
            | Self::TransferIo(_)
            | Self::Transport(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SshError;
    use bx_contracts::SshConnectionStage;

    #[test]
    fn identifies_the_connection_stage_for_setup_errors() {
        let dns = SshError::DnsLookupFailed(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "host not found",
        ));
        let channel = SshError::ChannelOpenFailed(russh::Error::SendError);

        assert_eq!(
            dns.connection_stage(),
            Some(SshConnectionStage::ResolvingDns)
        );
        assert_eq!(
            channel.connection_stage(),
            Some(SshConnectionStage::OpeningChannel)
        );
    }
}
