use std::fmt;

use secrecy::{ExposeSecret, ExposeSecretMut, SecretBox};

use crate::{PersistenceError, Result};

pub const DATA_KEY_LEN: usize = 32;

pub struct DataKey(SecretBox<[u8; DATA_KEY_LEN]>);

impl DataKey {
    pub fn generate() -> Result<Self> {
        let mut secret = SecretBox::<[u8; DATA_KEY_LEN]>::default();
        getrandom::fill(secret.expose_secret_mut()).map_err(PersistenceError::RandomSource)?;
        Ok(Self(secret))
    }

    pub fn bit_len(&self) -> usize {
        DATA_KEY_LEN * 8
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != DATA_KEY_LEN {
            return Err(PersistenceError::InvalidDataKeyLength {
                actual: bytes.len(),
            });
        }
        let mut secret = SecretBox::<[u8; DATA_KEY_LEN]>::default();
        secret.expose_secret_mut().copy_from_slice(bytes);
        Ok(Self(secret))
    }
}

impl ExposeSecret<[u8; DATA_KEY_LEN]> for DataKey {
    fn expose_secret(&self) -> &[u8; DATA_KEY_LEN] {
        self.0.expose_secret()
    }
}

impl fmt::Debug for DataKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DataKey([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_are_256_bits_and_redacted() {
        let first = DataKey::generate().unwrap();
        let second = DataKey::generate().unwrap();

        assert_eq!(first.bit_len(), 256);
        assert_ne!(first.expose_secret(), second.expose_secret());
        assert_eq!(format!("{first:?}"), "DataKey([REDACTED])");
    }

    #[test]
    fn rejects_data_keys_with_the_wrong_length() {
        let error = DataKey::from_bytes(&[0_u8; 31]).unwrap_err();
        assert!(matches!(
            error,
            PersistenceError::InvalidDataKeyLength { actual: 31 }
        ));
    }
}
