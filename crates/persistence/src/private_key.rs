use std::fmt;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret, SecretSlice};

use crate::{DataKey, PersistenceError, Result};

const MAGIC: &[u8; 4] = b"BXPK";
const FORMAT_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 4 + 1 + NONCE_LEN + 4;
const MAX_PRIVATE_KEY_LEN: usize = 4 * 1024 * 1024;
const AAD: &[u8] = b"bx-ssh/imported-private-key/v1";

pub struct EncryptedPrivateKey {
    nonce: [u8; NONCE_LEN],
    ciphertext: Vec<u8>,
}

impl EncryptedPrivateKey {
    pub fn encrypt(plaintext: &SecretSlice<u8>) -> Result<(Self, DataKey)> {
        if plaintext.expose_secret().is_empty()
            || plaintext.expose_secret().len() > MAX_PRIVATE_KEY_LEN
        {
            return Err(PersistenceError::InvalidPrivateKey);
        }

        let encryption_key = DataKey::generate()?;
        let encrypted = Self::encrypt_with_key(plaintext, &encryption_key)?;
        Ok((encrypted, encryption_key))
    }

    pub fn decrypt(&self, encryption_key: &DataKey) -> Result<SecretSlice<u8>> {
        let cipher = Aes256Gcm::new_from_slice(encryption_key.expose_secret())
            .map_err(|_| PersistenceError::AuthenticationFailed)?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&self.nonce),
                Payload {
                    msg: &self.ciphertext,
                    aad: AAD,
                },
            )
            .map_err(|_| PersistenceError::AuthenticationFailed)?;
        let mut plaintext = Zeroizing::new(plaintext);
        Ok(SecretSlice::from(std::mem::take(&mut *plaintext)))
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_LEN + self.ciphertext.len());
        bytes.extend_from_slice(MAGIC);
        bytes.push(FORMAT_VERSION);
        bytes.extend_from_slice(&self.nonce);
        bytes.extend_from_slice(&(self.ciphertext.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.ciphertext);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN + TAG_LEN || &bytes[..4] != MAGIC {
            return Err(PersistenceError::InvalidPrivateKeyRecord);
        }
        if bytes[4] != FORMAT_VERSION {
            return Err(PersistenceError::InvalidPrivateKeyRecord);
        }
        let ciphertext_len = u32::from_be_bytes(
            bytes[17..21]
                .try_into()
                .map_err(|_| PersistenceError::InvalidPrivateKeyRecord)?,
        ) as usize;
        if !(TAG_LEN..=MAX_PRIVATE_KEY_LEN + TAG_LEN).contains(&ciphertext_len)
            || bytes.len() != HEADER_LEN + ciphertext_len
        {
            return Err(PersistenceError::InvalidPrivateKeyRecord);
        }

        Ok(Self {
            nonce: bytes[5..17]
                .try_into()
                .map_err(|_| PersistenceError::InvalidPrivateKeyRecord)?,
            ciphertext: bytes[HEADER_LEN..].to_vec(),
        })
    }

    fn encrypt_with_key(plaintext: &SecretSlice<u8>, encryption_key: &DataKey) -> Result<Self> {
        let mut nonce = [0_u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(PersistenceError::RandomSource)?;
        let cipher = Aes256Gcm::new_from_slice(encryption_key.expose_secret())
            .map_err(|_| PersistenceError::EncryptionFailed)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.expose_secret(),
                    aad: AAD,
                },
            )
            .map_err(|_| PersistenceError::EncryptionFailed)?;
        Ok(Self { nonce, ciphertext })
    }
}

impl fmt::Debug for EncryptedPrivateKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncryptedPrivateKey")
            .field("ciphertext", &"[REDACTED]")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIVATE_KEY: &[u8] =
        b"-----BEGIN OPENSSH PRIVATE KEY-----\nsecurity-probe\n-----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn encrypts_with_an_independent_random_key_and_round_trips() {
        let plaintext = SecretSlice::from(PRIVATE_KEY.to_vec());
        let database_key = DataKey::generate().unwrap();
        let (encrypted, private_key_data_key) = EncryptedPrivateKey::encrypt(&plaintext).unwrap();
        let encoded = encrypted.to_bytes();

        assert_ne!(
            private_key_data_key.expose_secret(),
            database_key.expose_secret()
        );
        assert!(!contains(&encoded, PRIVATE_KEY));
        assert_eq!(
            format!("{encrypted:?}"),
            "EncryptedPrivateKey { ciphertext: \"[REDACTED]\" }"
        );

        let decoded = EncryptedPrivateKey::from_bytes(&encoded).unwrap();
        let decrypted = decoded.decrypt(&private_key_data_key).unwrap();
        assert_eq!(decrypted.expose_secret(), PRIVATE_KEY);
    }

    #[test]
    fn rejects_wrong_keys_and_tampered_ciphertext() {
        let plaintext = SecretSlice::from(PRIVATE_KEY.to_vec());
        let (encrypted, encryption_key) = EncryptedPrivateKey::encrypt(&plaintext).unwrap();
        let wrong_key = DataKey::generate().unwrap();
        assert!(matches!(
            encrypted.decrypt(&wrong_key).unwrap_err(),
            PersistenceError::AuthenticationFailed
        ));

        let mut encoded = encrypted.to_bytes();
        *encoded.last_mut().unwrap() ^= 1;
        let tampered = EncryptedPrivateKey::from_bytes(&encoded).unwrap();
        assert!(matches!(
            tampered.decrypt(&encryption_key).unwrap_err(),
            PersistenceError::AuthenticationFailed
        ));
    }

    #[test]
    fn rejects_empty_plaintext_and_malformed_records() {
        let empty = SecretSlice::from(Vec::<u8>::new());
        assert!(matches!(
            EncryptedPrivateKey::encrypt(&empty).unwrap_err(),
            PersistenceError::InvalidPrivateKey
        ));
        assert!(matches!(
            EncryptedPrivateKey::from_bytes(b"not a record").unwrap_err(),
            PersistenceError::InvalidPrivateKeyRecord
        ));
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }
}
