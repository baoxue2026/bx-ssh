mod credential;
mod database;
mod envelope;
mod error;
mod key;
mod private_key;
mod repository;
mod schema;

pub use credential::{CredentialStore, SecretCredentialStore, SystemCredentialStore};
pub use database::{EncryptedDatabase, Migration};
pub use envelope::MasterPasswordEnvelope;
pub use error::PersistenceError;
pub use key::DataKey;
pub use private_key::EncryptedPrivateKey;
pub use repository::ConnectionRepository;
pub use schema::{APPLICATION_MIGRATIONS, LATEST_SCHEMA_VERSION};
pub use secrecy::{ExposeSecret, SecretSlice, SecretString};

pub type Result<T> = std::result::Result<T, PersistenceError>;
