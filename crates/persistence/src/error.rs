use thiserror::Error;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("the operating system random source is unavailable")]
    RandomSource(#[source] getrandom::Error),
    #[error("the system credential store is locked or access was denied")]
    CredentialStoreLocked,
    #[error("the system credential store is unavailable")]
    CredentialStoreUnavailable,
    #[error("the system credential store failed while attempting to {operation}")]
    CredentialStoreFailure { operation: &'static str },
    #[error("the database data key is missing from the system credential store")]
    DatabaseKeyMissing,
    #[error("a database data key exists, but its encrypted database is missing")]
    DatabaseMissingForStoredKey,
    #[error("the stored database data key has an invalid length: expected 32 bytes, got {actual}")]
    InvalidDataKeyLength { actual: usize },
    #[error("failed to open the encrypted database")]
    DatabaseOpen(#[source] rusqlite::Error),
    #[error("SQLCipher rejected the database data key or the database is damaged")]
    DatabaseUnlock(#[source] rusqlite::Error),
    #[error("the linked SQLite library does not provide SQLCipher")]
    SqlCipherUnavailable,
    #[error("database migration {version} failed; the transaction was rolled back")]
    MigrationFailed {
        version: u32,
        #[source]
        source: rusqlite::Error,
    },
    #[error("database migrations must be strictly ordered by version")]
    InvalidMigrationOrder,
    #[error("database schema version {actual} is newer than supported version {supported}")]
    DatabaseVersionTooNew { actual: u32, supported: u32 },
    #[error("database operation failed while attempting to {operation}")]
    DatabaseOperation {
        operation: &'static str,
        #[source]
        source: rusqlite::Error,
    },
    #[error("the connection configuration is invalid")]
    InvalidConnectionConfiguration,
    #[error("the database contains an invalid {entity} record")]
    InvalidStoredRecord { entity: &'static str },
    #[error("a timestamp is outside the supported database range")]
    InvalidTimestamp,
    #[error("the encrypted key envelope is malformed")]
    InvalidEnvelope,
    #[error("the encrypted key envelope uses an unsupported version or KDF configuration")]
    UnsupportedEnvelope,
    #[error("Argon2id could not derive the key-encryption key")]
    KeyDerivation(#[source] argon2::Error),
    #[error("encryption failed")]
    EncryptionFailed,
    #[error("ciphertext authentication failed; the password, key, or data is incorrect")]
    AuthenticationFailed,
    #[error("the imported private key is empty or exceeds the supported size")]
    InvalidPrivateKey,
    #[error("the encrypted private-key record is malformed")]
    InvalidPrivateKeyRecord,
}
