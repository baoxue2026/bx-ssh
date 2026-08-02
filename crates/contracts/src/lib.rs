use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[cfg(test)]
mod tests {
    use super::{AppInfo, HostKeyInfo};

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
}
