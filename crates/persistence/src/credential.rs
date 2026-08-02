use keyring::{Entry, Error as KeyringError};
use secrecy::zeroize::{Zeroize, Zeroizing};
use secrecy::ExposeSecret;

use crate::{DataKey, PersistenceError, Result};

pub trait CredentialStore {
    fn load_data_key(&self) -> Result<Option<DataKey>>;
    fn save_data_key(&self, key: &DataKey) -> Result<()>;
    fn delete_data_key(&self) -> Result<()>;
}

pub struct SystemCredentialStore {
    entry: Entry,
}

impl SystemCredentialStore {
    pub fn new(service: &str, account: &str) -> Result<Self> {
        let entry = Entry::new(service, account)
            .map_err(|source| Self::operation_error("initialize", source))?;
        Ok(Self { entry })
    }

    fn operation_error(operation: &'static str, source: KeyringError) -> PersistenceError {
        match source {
            KeyringError::NoStorageAccess(_) => PersistenceError::CredentialStoreLocked,
            #[cfg(target_os = "linux")]
            KeyringError::PlatformFailure(_) => PersistenceError::CredentialStoreUnavailable,
            KeyringError::NoDefaultStore | KeyringError::NotSupportedByStore(_) => {
                PersistenceError::CredentialStoreUnavailable
            }
            mut source => {
                clear_secret_from_error(&mut source);
                PersistenceError::CredentialStoreFailure { operation }
            }
        }
    }
}

impl CredentialStore for SystemCredentialStore {
    fn load_data_key(&self) -> Result<Option<DataKey>> {
        match self.entry.get_secret() {
            Ok(secret) => {
                let secret = Zeroizing::new(secret);
                DataKey::from_bytes(secret.as_ref()).map(Some)
            }
            Err(KeyringError::NoEntry) => Ok(None),
            Err(source) => Err(Self::operation_error("read a data key", source)),
        }
    }

    fn save_data_key(&self, key: &DataKey) -> Result<()> {
        self.entry
            .set_secret(key.expose_secret())
            .map_err(|source| Self::operation_error("save a data key", source))
    }

    fn delete_data_key(&self) -> Result<()> {
        match self.entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(source) => Err(Self::operation_error("delete a data key", source)),
        }
    }
}

fn clear_secret_from_error(source: &mut KeyringError) {
    match source {
        KeyringError::BadEncoding(secret) | KeyringError::BadDataFormat(secret, _) => {
            secret.zeroize();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    #[test]
    fn maps_denied_or_locked_storage_to_an_explicit_error() {
        let source = KeyringError::NoStorageAccess(Box::new(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "test lock",
        )));
        let error = SystemCredentialStore::operation_error("read", source);
        assert!(matches!(error, PersistenceError::CredentialStoreLocked));
    }

    #[test]
    fn maps_a_missing_default_store_to_an_explicit_error() {
        let error = SystemCredentialStore::operation_error("read", KeyringError::NoDefaultStore);
        assert!(matches!(
            error,
            PersistenceError::CredentialStoreUnavailable
        ));
    }

    #[test]
    fn malformed_credential_bytes_are_not_retained_in_errors() {
        let error = SystemCredentialStore::operation_error(
            "read",
            KeyringError::BadEncoding(vec![11, 22, 33]),
        );
        let debug = format!("{error:?}");
        assert!(!debug.contains("11"));
        assert!(!debug.contains("22"));
        assert!(!debug.contains("33"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn maps_secret_service_connection_failure_to_unavailable() {
        let source = KeyringError::PlatformFailure(Box::new(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "test service absence",
        )));
        let error = SystemCredentialStore::operation_error("read", source);
        assert!(matches!(
            error,
            PersistenceError::CredentialStoreUnavailable
        ));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    #[test]
    #[ignore = "touches Windows Credential Manager; run explicitly during security validation"]
    fn system_credential_store_round_trip() {
        struct Cleanup<'a>(&'a SystemCredentialStore);

        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete_data_key();
            }
        }

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let account = format!("security-smoke-{}-{unique}", std::process::id());
        let store = SystemCredentialStore::new("bx-ssh-test", &account).unwrap();
        let cleanup = Cleanup(&store);
        let key = DataKey::generate().unwrap();

        store.delete_data_key().unwrap();
        store.save_data_key(&key).unwrap();
        let loaded = store.load_data_key().unwrap().unwrap();
        assert_eq!(loaded.expose_secret(), key.expose_secret());
        store.delete_data_key().unwrap();
        assert!(store.load_data_key().unwrap().is_none());
        drop(cleanup);
    }
}
