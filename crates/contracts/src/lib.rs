use serde::{Deserialize, Serialize};
use specta::Type;

mod connection;
mod sensitive;
mod settings;

pub use connection::{
    AuthMethod, ConnectionCatalog, ConnectionConfig, ConnectionDetails, ConnectionGroup,
    ConnectionGroupValidationError, ConnectionListItem, ConnectionSettings,
    ConnectionSettingsLayers, ConnectionSettingsOverride, ConnectionSettingsScope,
    ConnectionSettingsSnapshot, ConnectionSettingsValidationError, ConnectionValidationError,
    OpenSshDuplicateStrategy, OpenSshImportError, OpenSshImportItem, OpenSshImportPreview,
    OpenSshImportRequest, OpenSshImportResult, OpenSshImportWarning, DEFAULT_CONNECTION_PORT,
    DEFAULT_CONNECT_TIMEOUT_SECS, DEFAULT_KEEP_ALIVE_SECS, MIN_CONNECT_TIMEOUT_SECS,
};
pub use sensitive::SensitiveString;
pub use settings::{
    ApplicationLanguage, ApplicationSettings, ApplicationSettingsValidationError,
    GlobalSettingsSnapshot, LogLevel, TerminalColorScheme, TerminalCursorStyle, TerminalFontFamily,
    TerminalLineHeight, ThemeMode, CURRENT_APPLICATION_SETTINGS_VERSION, MAX_TERMINAL_FONT_SIZE,
    MIN_TERMINAL_FONT_SIZE,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

impl AppInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub algorithm: String,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SshConnectionStage {
    Created,
    ResolvingDns,
    ConnectingTcp,
    Handshaking,
    Authenticating,
    OpeningChannel,
    Connected,
    Closing,
    Closed,
    Cancelled,
    Failed,
}

impl HostKeyInfo {
    pub fn new(algorithm: impl Into<String>, fingerprint_sha256: impl Into<String>) -> Self {
        Self {
            algorithm: algorithm.into(),
            fingerprint_sha256: fingerprint_sha256.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RemoteFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SftpConflictAction {
    Ask,
    Overwrite,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SftpTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferProgress {
    pub transfer_id: Option<String>,
    pub direction: SftpTransferDirection,
    pub path: String,
    pub bytes_transferred: u64,
    pub total_bytes: Option<u64>,
    pub files_completed: u64,
    pub total_files: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteFileKind,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectoryListing {
    pub path: String,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LocalFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub kind: LocalFileKind,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub readonly: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<LocalFileEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub bytes_per_second: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferBatchSummary {
    pub files: u64,
    pub directories: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub bytes_per_second: u64,
}

#[cfg(test)]
mod tests {
    use super::{
        AppInfo, HostKeyInfo, LocalDirectoryListing, LocalFileEntry, LocalFileKind,
        RemoteFileEntry, RemoteFileKind, SftpTransferDirection, SftpTransferProgress,
        SshConnectionStage, TransferBatchSummary, TransferSummary,
    };

    #[test]
    fn creates_app_info() {
        let info = AppInfo::new("BX SSH", "0.1.0");

        assert_eq!(info.name, "BX SSH");
        assert_eq!(info.version, "0.1.0");
    }

    #[test]
    fn creates_host_key_info() {
        let info = HostKeyInfo::new(
            "ssh-ed25519",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert_eq!(info.algorithm, "ssh-ed25519");
        assert!(info.fingerprint_sha256.starts_with("SHA256:"));
    }

    #[test]
    fn serializes_connection_stages_with_stable_names() {
        assert_eq!(
            serde_json::to_value(SshConnectionStage::ResolvingDns).unwrap(),
            "resolvingDns"
        );
        assert_eq!(
            serde_json::to_value(SshConnectionStage::OpeningChannel).unwrap(),
            "openingChannel"
        );
    }

    #[test]
    fn serializes_sftp_contracts_with_stable_field_names() {
        let entry = RemoteFileEntry {
            name: "archive.tar".to_owned(),
            path: "/tmp/archive.tar".to_owned(),
            kind: RemoteFileKind::File,
            size: 1024,
            modified_at: Some(1_700_000_000),
            permissions: Some(0o640),
        };
        let summary = TransferSummary {
            bytes: 1024,
            elapsed_ms: 20,
            bytes_per_second: 51_200,
            sha256: "abc123".to_owned(),
        };

        assert_eq!(entry.kind, RemoteFileKind::File);
        assert_eq!(entry.permissions, Some(0o640));
        assert_eq!(summary.bytes_per_second, 51_200);

        let batch = TransferBatchSummary {
            files: 2,
            directories: 3,
            bytes: 2048,
            elapsed_ms: 40,
            bytes_per_second: 51_200,
        };
        let serialized = serde_json::to_value(batch).unwrap();
        assert_eq!(serialized["files"], 2);
        assert_eq!(serialized["directories"], 3);
        assert_eq!(serialized["bytesPerSecond"], 51_200);

        let progress = SftpTransferProgress {
            transfer_id: Some("transfer-1".to_owned()),
            direction: SftpTransferDirection::Upload,
            path: "C:\\tmp\\archive.tar".to_owned(),
            bytes_transferred: 512,
            total_bytes: Some(1024),
            files_completed: 0,
            total_files: Some(1),
        };
        let serialized = serde_json::to_value(progress).unwrap();
        assert_eq!(serialized["transferId"], "transfer-1");
        assert_eq!(serialized["direction"], "upload");
        assert_eq!(serialized["bytesTransferred"], 512);
        assert_eq!(serialized["totalBytes"], 1024);
    }

    #[test]
    fn serializes_local_file_contracts_with_stable_path_types() {
        let entry = LocalFileEntry {
            name: "Downloads".to_owned(),
            path: "C:\\Users\\bxssh\\Downloads".to_owned(),
            kind: LocalFileKind::Directory,
            size: 0,
            modified_at: Some(1_700_000_000),
            readonly: false,
            hidden: false,
        };
        let listing = LocalDirectoryListing {
            path: "C:\\Users\\bxssh".to_owned(),
            parent_path: Some("C:\\Users".to_owned()),
            entries: vec![entry],
        };

        let serialized = serde_json::to_value(listing).unwrap();
        assert_eq!(serialized["parentPath"], "C:\\Users");
        assert_eq!(serialized["entries"][0]["kind"], "directory");
        assert_eq!(serialized["entries"][0]["readonly"], false);
    }
}
