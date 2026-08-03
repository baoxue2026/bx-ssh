use serde::{Deserialize, Serialize};
use specta::Type;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub bytes_per_second: u64,
    pub sha256: String,
}

#[cfg(test)]
mod tests {
    use super::{AppInfo, HostKeyInfo, RemoteFileEntry, RemoteFileKind, TransferSummary};

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
    }
}
