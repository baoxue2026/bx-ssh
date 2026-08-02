use std::fmt;

use crate::SshError;

const SHA256_PREFIX: &str = "SHA256:";
const SHA256_BASE64_LENGTH: usize = 43;

#[derive(Clone, PartialEq, Eq)]
pub struct HostFingerprint(String);

impl HostFingerprint {
    pub fn parse(value: impl Into<String>) -> Result<Self, SshError> {
        let value = value.into();
        let encoded = value
            .strip_prefix(SHA256_PREFIX)
            .ok_or(SshError::InvalidFingerprint)?;

        if encoded.len() != SHA256_BASE64_LENGTH
            || !encoded
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        {
            return Err(SshError::InvalidFingerprint);
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for HostFingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("HostFingerprint")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for HostFingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::HostFingerprint;
    use crate::SshError;

    const VALID: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn accepts_openssh_sha256_fingerprint() {
        let fingerprint = HostFingerprint::parse(VALID).unwrap();

        assert_eq!(fingerprint.as_str(), VALID);
    }

    #[test]
    fn rejects_wrong_prefix_length_and_characters() {
        for value in [
            "MD5:aa:bb:cc",
            "SHA256:short",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_",
        ] {
            assert!(matches!(
                HostFingerprint::parse(value),
                Err(SshError::InvalidFingerprint)
            ));
        }
    }
}
