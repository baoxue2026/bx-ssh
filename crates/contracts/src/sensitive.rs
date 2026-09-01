use std::fmt;

use secrecy::zeroize::Zeroize;
use serde::{Deserialize, Serialize};
use specta::Type;

/// A string that must not be rendered or logged as plaintext.
///
/// The transparent serde representation keeps the IPC wire contract as a
/// string while the Rust value is cleared when it is dropped. Callers should
/// use `into_inner` only at the final hand-off to a library that requires an
/// owned `String`.
#[derive(Clone, Deserialize, Serialize, Type)]
#[serde(transparent)]
pub struct SensitiveString(String);

impl SensitiveString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(mut self) -> String {
        std::mem::take(&mut self.0)
    }
}

impl From<String> for SensitiveString {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

impl From<&str> for SensitiveString {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl fmt::Debug for SensitiveString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl fmt::Display for SensitiveString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SensitiveString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::SensitiveString;

    #[test]
    fn redacts_debug_and_display_output() {
        let secret = SensitiveString::from("password-123");

        assert_eq!(format!("{secret:?}"), "[REDACTED]");
        assert_eq!(format!("{secret}"), "[REDACTED]");
        assert!(!format!("{secret:?}").contains("password-123"));
    }

    #[test]
    fn keeps_the_wire_shape_as_a_string() {
        let secret: SensitiveString = serde_json::from_str("\"secret\"").unwrap();

        assert_eq!(secret.as_str(), "secret");
        assert_eq!(serde_json::to_string(&secret).unwrap(), "\"secret\"");
        assert_eq!(secret.into_inner(), "secret");
    }
}
