use bx_ssh_core::SshError;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl CommandError {
    pub(crate) fn session_not_found(kind: &str) -> Self {
        Self {
            code: "session_not_found".to_owned(),
            message: format!("{kind} session was not found"),
        }
    }

    pub(crate) fn session_closed(kind: &str) -> Self {
        Self {
            code: "session_closed".to_owned(),
            message: format!("{kind} session is already closed"),
        }
    }
}

impl From<SshError> for CommandError {
    fn from(error: SshError) -> Self {
        let code = match &error {
            SshError::InvalidHost => "invalid_host",
            SshError::InvalidPort => "invalid_port",
            SshError::InvalidUsername => "invalid_username",
            SshError::InvalidFingerprint => "invalid_fingerprint",
            SshError::InvalidTerminalSize => "invalid_terminal_size",
            SshError::InvalidRemotePath => "invalid_remote_path",
            SshError::InvalidLocalFile => "invalid_local_file",
            SshError::LocalTargetExists => "local_target_exists",
            SshError::RemoteTargetExists => "remote_target_exists",
            SshError::TransferIntegrityMismatch { .. } => "transfer_integrity_mismatch",
            SshError::ConnectTimeout => "connect_timeout",
            SshError::AuthenticationTimeout => "authentication_timeout",
            SshError::HostKeyUnavailable => "host_key_unavailable",
            SshError::HostKeyMismatch { .. } => "host_key_mismatch",
            SshError::AuthenticationRejected { .. } => "authentication_rejected",
            SshError::LegacyRsaSignatureOnly => "legacy_rsa_signature_only",
            SshError::ChannelRequestRejected { .. } => "channel_request_rejected",
            SshError::ChannelClosed { .. } => "channel_closed",
            SshError::PrivateKey(_) => "private_key_error",
            SshError::Sftp(_) => "sftp_error",
            SshError::TransferIo(_) => "transfer_io_error",
            SshError::Transport(_) => "transport_error",
        };

        Self {
            code: code.to_owned(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CommandError;
    use bx_ssh_core::SshError;

    #[test]
    fn maps_ssh_and_sftp_errors_to_stable_codes() {
        let host_key = CommandError::from(SshError::HostKeyMismatch {
            expected: "SHA256:expected".to_owned(),
            actual: "SHA256:actual".to_owned(),
        });
        let remote_path = CommandError::from(SshError::InvalidRemotePath);

        assert_eq!(host_key.code, "host_key_mismatch");
        assert_eq!(remote_path.code, "invalid_remote_path");
    }
}
