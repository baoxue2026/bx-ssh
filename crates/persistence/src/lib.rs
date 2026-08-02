mod credential;
mod database;
mod envelope;
mod error;
mod key;
mod private_key;

pub use credential::{CredentialStore, SystemCredentialStore};
pub use database::{EncryptedDatabase, Migration};
pub use envelope::MasterPasswordEnvelope;
pub use error::PersistenceError;
pub use key::DataKey;
pub use private_key::EncryptedPrivateKey;
pub use secrecy::{ExposeSecret, SecretSlice, SecretString};

pub type Result<T> = std::result::Result<T, PersistenceError>;
