use std::fmt;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret, SecretString};

use crate::{DataKey, PersistenceError, Result};

const MAGIC: &[u8; 4] = b"BXDK";
const FORMAT_VERSION: u8 = 1;
const MEMORY_COST_KIB: u32 = 64 * 1024;
const TIME_COST: u32 = 3;
const PARALLELISM: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const CIPHERTEXT_LEN: usize = 48;
const HEADER_LEN: usize = 4 + 1 + 4 + 4 + 4 + SALT_LEN + NONCE_LEN;
const AAD: &[u8] = b"bx-ssh/database-key/v1";

pub struct MasterPasswordEnvelope {
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
    ciphertext: Vec<u8>,
}

impl fmt::Debug for MasterPasswordEnvelope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MasterPasswordEnvelope([REDACTED])")
    }
}

impl MasterPasswordEnvelope {
    pub fn seal(data_key: &DataKey, password: &SecretString) -> Result<Self> {
        let mut salt = [0_u8; SALT_LEN];
        let mut nonce = [0_u8; NONCE_LEN];
        getrandom::fill(&mut salt).map_err(PersistenceError::RandomSource)?;
        getrandom::fill(&mut nonce).map_err(PersistenceError::RandomSource)?;

        let wrapping_key = derive_wrapping_key(password, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
            .map_err(|_| PersistenceError::EncryptionFailed)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: data_key.expose_secret(),
                    aad: AAD,
                },
            )
            .map_err(|_| PersistenceError::EncryptionFailed)?;

        Ok(Self {
            salt,
            nonce,
            ciphertext,
        })
    }

    pub fn open(&self, password: &SecretString) -> Result<DataKey> {
        let wrapping_key = derive_wrapping_key(password, &self.salt)?;
        let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
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
        let plaintext = Zeroizing::new(plaintext);
        DataKey::from_bytes(plaintext.as_ref())
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_LEN + self.ciphertext.len());
        bytes.extend_from_slice(MAGIC);
        bytes.push(FORMAT_VERSION);
        bytes.extend_from_slice(&MEMORY_COST_KIB.to_be_bytes());
        bytes.extend_from_slice(&TIME_COST.to_be_bytes());
        bytes.extend_from_slice(&PARALLELISM.to_be_bytes());
        bytes.extend_from_slice(&self.salt);
        bytes.extend_from_slice(&self.nonce);
        bytes.extend_from_slice(&self.ciphertext);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != HEADER_LEN + CIPHERTEXT_LEN || &bytes[..4] != MAGIC {
            return Err(PersistenceError::InvalidEnvelope);
        }
        if bytes[4] != FORMAT_VERSION
            || read_u32(&bytes[5..9]) != MEMORY_COST_KIB
            || read_u32(&bytes[9..13]) != TIME_COST
            || read_u32(&bytes[13..17]) != PARALLELISM
        {
            return Err(PersistenceError::UnsupportedEnvelope);
        }

        let salt = bytes[17..33]
            .try_into()
            .map_err(|_| PersistenceError::InvalidEnvelope)?;
        let nonce = bytes[33..45]
            .try_into()
            .map_err(|_| PersistenceError::InvalidEnvelope)?;
        Ok(Self {
            salt,
            nonce,
            ciphertext: bytes[45..].to_vec(),
        })
    }
}

fn derive_wrapping_key(
    password: &SecretString,
    salt: &[u8; SALT_LEN],
) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(MEMORY_COST_KIB, TIME_COST, PARALLELISM, Some(32))
        .map_err(PersistenceError::KeyDerivation)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(password.expose_secret().as_bytes(), salt, output.as_mut())
        .map_err(PersistenceError::KeyDerivation)?;
    Ok(output)
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("fixed envelope field length"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_a_random_data_key_without_using_the_password_as_that_key() {
        let data_key = DataKey::generate().unwrap();
        let password = SecretString::from("correct horse battery staple");
        let envelope = MasterPasswordEnvelope::seal(&data_key, &password).unwrap();
        let encoded = envelope.to_bytes();

        assert!(!contains(&encoded, password.expose_secret().as_bytes()));
        assert!(!contains(&encoded, data_key.expose_secret()));

        let decoded = MasterPasswordEnvelope::from_bytes(&encoded).unwrap();
        let opened = decoded.open(&password).unwrap();
        assert_eq!(opened.expose_secret(), data_key.expose_secret());
    }

    #[test]
    fn wrong_password_and_tampering_fail_authentication() {
        let key = DataKey::generate().unwrap();
        let password = SecretString::from("right password");
        let envelope = MasterPasswordEnvelope::seal(&key, &password).unwrap();
        let wrong_password = SecretString::from("wrong password");
        assert!(matches!(
            envelope.open(&wrong_password).unwrap_err(),
            PersistenceError::AuthenticationFailed
        ));

        let mut encoded = envelope.to_bytes();
        let last = encoded.last_mut().unwrap();
        *last ^= 1;
        let tampered = MasterPasswordEnvelope::from_bytes(&encoded).unwrap();
        assert!(matches!(
            tampered.open(&password).unwrap_err(),
            PersistenceError::AuthenticationFailed
        ));
    }

    #[test]
    fn rejects_unknown_versions_and_malformed_envelopes() {
        assert!(matches!(
            MasterPasswordEnvelope::from_bytes(b"short").unwrap_err(),
            PersistenceError::InvalidEnvelope
        ));

        let key = DataKey::generate().unwrap();
        let password = SecretString::from("password");
        let mut encoded = MasterPasswordEnvelope::seal(&key, &password)
            .unwrap()
            .to_bytes();
        encoded[4] = 2;
        assert!(matches!(
            MasterPasswordEnvelope::from_bytes(&encoded).unwrap_err(),
            PersistenceError::UnsupportedEnvelope
        ));
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }
}
