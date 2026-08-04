use bx_persistence::PersistenceError;
use bx_ssh_core::SshError;
use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandErrorCode {
    InvalidHost,
    InvalidPort,
    InvalidUsername,
    InvalidFingerprint,
    InvalidTerminalSize,
    InvalidRemotePath,
    InvalidLocalFile,
    LocalTargetExists,
    RemoteTargetExists,
    TransferIntegrityMismatch,
    ConnectTimeout,
    AuthenticationTimeout,
    HostKeyUnavailable,
    HostKeyMismatch,
    AuthenticationRejected,
    LegacyRsaSignatureOnly,
    ChannelRequestRejected,
    ChannelClosed,
    PrivateKeyError,
    SftpError,
    TransferIoError,
    TransportError,
    SessionNotFound,
    SessionClosed,
    UpdateNotAvailable,
    UpdateChanged,
    UpdateSignatureInvalid,
    UpdateInsecureEndpoint,
    UpdateUnavailable,
    UpdateFailed,
    WebviewMemoryUsageFailed,
    DatabaseUnavailable,
    DatabaseQueryFailed,
    OpenSshConfigNotFound,
    OpenSshConfigIoError,
    OpenSshConfigInvalid,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    pub(crate) code: CommandErrorCode,
    pub(crate) message: String,
}

impl CommandError {
    pub(crate) fn new(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn session_not_found(kind: &str) -> Self {
        Self::new(
            CommandErrorCode::SessionNotFound,
            format!("{kind} session was not found"),
        )
    }

    pub(crate) fn session_closed(kind: &str) -> Self {
        Self::new(
            CommandErrorCode::SessionClosed,
            format!("{kind} session is already closed"),
        )
    }

    pub(crate) fn update(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }
}

impl From<SshError> for CommandError {
    fn from(error: SshError) -> Self {
        let code = match &error {
            SshError::InvalidHost => CommandErrorCode::InvalidHost,
            SshError::InvalidPort => CommandErrorCode::InvalidPort,
            SshError::InvalidUsername => CommandErrorCode::InvalidUsername,
            SshError::InvalidFingerprint => CommandErrorCode::InvalidFingerprint,
            SshError::InvalidTerminalSize => CommandErrorCode::InvalidTerminalSize,
            SshError::InvalidRemotePath => CommandErrorCode::InvalidRemotePath,
            SshError::InvalidLocalFile => CommandErrorCode::InvalidLocalFile,
            SshError::LocalTargetExists => CommandErrorCode::LocalTargetExists,
            SshError::RemoteTargetExists => CommandErrorCode::RemoteTargetExists,
            SshError::TransferIntegrityMismatch { .. } => {
                CommandErrorCode::TransferIntegrityMismatch
            }
            SshError::ConnectTimeout => CommandErrorCode::ConnectTimeout,
            SshError::AuthenticationTimeout => CommandErrorCode::AuthenticationTimeout,
            SshError::HostKeyUnavailable => CommandErrorCode::HostKeyUnavailable,
            SshError::HostKeyMismatch { .. } => CommandErrorCode::HostKeyMismatch,
            SshError::AuthenticationRejected { .. } => CommandErrorCode::AuthenticationRejected,
            SshError::LegacyRsaSignatureOnly => CommandErrorCode::LegacyRsaSignatureOnly,
            SshError::ChannelRequestRejected { .. } => CommandErrorCode::ChannelRequestRejected,
            SshError::ChannelClosed { .. } => CommandErrorCode::ChannelClosed,
            SshError::PrivateKey(_) => CommandErrorCode::PrivateKeyError,
            SshError::Sftp(_) => CommandErrorCode::SftpError,
            SshError::TransferIo(_) => CommandErrorCode::TransferIoError,
            SshError::Transport(_) => CommandErrorCode::TransportError,
        };

        Self::new(code, error.to_string())
    }
}

impl From<PersistenceError> for CommandError {
    fn from(error: PersistenceError) -> Self {
        let code = match &error {
            PersistenceError::DatabaseOperation { .. }
            | PersistenceError::InvalidConnectionConfiguration
            | PersistenceError::InvalidStoredRecord { .. }
            | PersistenceError::InvalidTimestamp => CommandErrorCode::DatabaseQueryFailed,
            _ => CommandErrorCode::DatabaseUnavailable,
        };
        Self::new(code, error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandError, CommandErrorCode};
    use bx_ssh_core::SshError;

    #[test]
    fn maps_ssh_and_sftp_errors_to_stable_codes() {
        let host_key = CommandError::from(SshError::HostKeyMismatch {
            expected: "SHA256:expected".to_owned(),
            actual: "SHA256:actual".to_owned(),
        });
        let remote_path = CommandError::from(SshError::InvalidRemotePath);

        assert_eq!(host_key.code, CommandErrorCode::HostKeyMismatch);
        assert_eq!(remote_path.code, CommandErrorCode::InvalidRemotePath);

        let serialized = serde_json::to_value(host_key).expect("command error must serialize");
        assert_eq!(serialized["code"], "host_key_mismatch");
        assert_eq!(
            serialized["message"],
            "server host key changed: expected SHA256:expected, received SHA256:actual"
        );
    }

    #[test]
    fn maps_database_errors_without_exposing_internal_sql() {
        let query = CommandError::from(bx_persistence::PersistenceError::InvalidStoredRecord {
            entity: "connection",
        });
        let unavailable = CommandError::from(bx_persistence::PersistenceError::DatabaseKeyMissing);

        assert_eq!(query.code, CommandErrorCode::DatabaseQueryFailed);
        assert_eq!(unavailable.code, CommandErrorCode::DatabaseUnavailable);
        assert!(!query.message.contains("SELECT"));
    }
}
