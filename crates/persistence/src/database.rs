use std::fmt;
use std::path::Path;

use rusqlite::{ffi, Connection, Transaction};
use secrecy::ExposeSecret;

use crate::key::DATA_KEY_LEN;
use crate::{CredentialStore, DataKey, PersistenceError, Result};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Migration {
    version: u32,
    sql: &'static str,
}

impl Migration {
    pub const fn new(version: u32, sql: &'static str) -> Self {
        Self { version, sql }
    }

    pub const fn version(self) -> u32 {
        self.version
    }
}

pub struct EncryptedDatabase {
    connection: Connection,
}

impl fmt::Debug for EncryptedDatabase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EncryptedDatabase([REDACTED])")
    }
}

impl EncryptedDatabase {
    pub fn open(path: impl AsRef<Path>, key: &DataKey) -> Result<Self> {
        let connection = Connection::open(path).map_err(PersistenceError::DatabaseOpen)?;
        apply_raw_key(&connection, key)?;

        let cipher_version = connection
            .query_row("PRAGMA cipher_version", [], |row| row.get::<_, String>(0))
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => PersistenceError::SqlCipherUnavailable,
                source => PersistenceError::DatabaseUnlock(source),
            })?;
        if cipher_version.trim().is_empty() {
            return Err(PersistenceError::SqlCipherUnavailable);
        }

        connection
            .query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(PersistenceError::DatabaseUnlock)?;
        connection
            .pragma_update(None, "cipher_memory_security", "ON")
            .map_err(PersistenceError::DatabaseUnlock)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(PersistenceError::DatabaseUnlock)?;

        Ok(Self { connection })
    }

    pub fn open_or_initialize(
        path: impl AsRef<Path>,
        credential_store: &impl CredentialStore,
    ) -> Result<Self> {
        let path = path.as_ref();
        let database_exists = path.exists();
        let stored_key = credential_store.load_data_key()?;

        match (database_exists, stored_key) {
            (true, Some(key)) => Self::open(path, &key),
            (true, None) => Err(PersistenceError::DatabaseKeyMissing),
            (false, Some(_)) => Err(PersistenceError::DatabaseMissingForStoredKey),
            (false, None) => {
                let key = DataKey::generate()?;
                credential_store.save_data_key(&key)?;
                match Self::open(path, &key) {
                    Ok(database) => Ok(database),
                    Err(open_error) => {
                        credential_store.delete_data_key()?;
                        Err(open_error)
                    }
                }
            }
        }
    }

    pub fn apply_migrations(&mut self, migrations: &[Migration]) -> Result<()> {
        if migrations
            .windows(2)
            .any(|pair| pair[0].version >= pair[1].version)
        {
            return Err(PersistenceError::InvalidMigrationOrder);
        }

        let current_version: u32 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(PersistenceError::DatabaseOpen)?;
        if let Some(latest) = migrations.last() {
            if current_version > latest.version {
                return Err(PersistenceError::DatabaseVersionTooNew {
                    actual: current_version,
                    supported: latest.version,
                });
            }
        }
        let pending = migrations
            .iter()
            .copied()
            .filter(|migration| migration.version > current_version)
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(());
        }

        let transaction = self
            .connection
            .transaction()
            .map_err(PersistenceError::DatabaseOpen)?;
        for migration in pending {
            if let Err(source) = transaction
                .execute_batch(migration.sql)
                .and_then(|()| transaction.pragma_update(None, "user_version", migration.version))
            {
                return Err(PersistenceError::MigrationFailed {
                    version: migration.version,
                    source,
                });
            }
        }
        transaction
            .commit()
            .map_err(|source| PersistenceError::MigrationFailed {
                version: migrations
                    .last()
                    .map_or(current_version, |item| item.version),
                source,
            })
    }

    pub fn user_version(&self) -> Result<u32> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(PersistenceError::DatabaseOpen)
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn transaction(&mut self) -> rusqlite::Result<Transaction<'_>> {
        self.connection.transaction()
    }
}

fn apply_raw_key(connection: &Connection, key: &DataKey) -> Result<()> {
    // SQLCipher copies the key before returning. Passing raw bytes avoids constructing a
    // PRAGMA string containing a hexadecimal copy of the database key.
    let result = unsafe {
        ffi::sqlite3_key(
            connection.handle(),
            key.expose_secret().as_ptr().cast(),
            DATA_KEY_LEN as i32,
        )
    };
    if result == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(PersistenceError::DatabaseUnlock(
            rusqlite::Error::SqliteFailure(ffi::Error::new(result), None),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct MemoryCredentialStore {
        key: RefCell<Option<[u8; DATA_KEY_LEN]>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn load_data_key(&self) -> Result<Option<DataKey>> {
            self.key
                .borrow()
                .as_ref()
                .map(|key| DataKey::from_bytes(key))
                .transpose()
        }

        fn save_data_key(&self, key: &DataKey) -> Result<()> {
            self.key.replace(Some(*key.expose_secret()));
            Ok(())
        }

        fn delete_data_key(&self) -> Result<()> {
            self.key.replace(None);
            Ok(())
        }
    }

    #[test]
    fn initializes_and_reopens_with_a_stored_random_key() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.db");
        let store = MemoryCredentialStore::default();

        let mut database = EncryptedDatabase::open_or_initialize(&path, &store).unwrap();
        database
            .apply_migrations(&[Migration::new(
                1,
                "CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )])
            .unwrap();
        drop(database);

        let reopened = EncryptedDatabase::open_or_initialize(&path, &store).unwrap();
        assert_eq!(reopened.user_version().unwrap(), 1);
    }

    #[test]
    fn refuses_to_replace_an_existing_database_when_its_key_is_missing() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.db");
        fs::write(&path, b"existing database bytes").unwrap();
        let store = MemoryCredentialStore::default();

        let error = EncryptedDatabase::open_or_initialize(&path, &store).unwrap_err();
        assert!(matches!(error, PersistenceError::DatabaseKeyMissing));
        assert_eq!(fs::read(path).unwrap(), b"existing database bytes");
    }

    #[test]
    fn reports_an_orphaned_credential_instead_of_silently_creating_a_database() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing.db");
        let store = MemoryCredentialStore::default();
        store.save_data_key(&DataKey::generate().unwrap()).unwrap();

        let error = EncryptedDatabase::open_or_initialize(&path, &store).unwrap_err();
        assert!(matches!(
            error,
            PersistenceError::DatabaseMissingForStoredKey
        ));
        assert!(!path.exists());
    }

    #[test]
    fn a_wrong_key_cannot_read_the_database_schema() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.db");
        let correct_key = DataKey::generate().unwrap();
        let wrong_key = DataKey::generate().unwrap();
        let mut database = EncryptedDatabase::open(&path, &correct_key).unwrap();
        database
            .apply_migrations(&[Migration::new(1, "CREATE TABLE proof (value TEXT);")])
            .unwrap();
        drop(database);

        let error = EncryptedDatabase::open(&path, &wrong_key).unwrap_err();
        assert!(matches!(error, PersistenceError::DatabaseUnlock(_)));
    }

    #[test]
    fn database_file_does_not_contain_plaintext_schema_or_values() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.db");
        let key = DataKey::generate().unwrap();
        let mut database = EncryptedDatabase::open(&path, &key).unwrap();
        database
            .apply_migrations(&[Migration::new(
                1,
                "CREATE TABLE security_probe (value TEXT NOT NULL);\
                 INSERT INTO security_probe VALUES ('BX_SSH_PLAINTEXT_CANARY_7E91');",
            )])
            .unwrap();
        drop(database);

        let bytes = fs::read(path).unwrap();
        assert!(!contains(&bytes, b"SQLite format 3"));
        assert!(!contains(&bytes, b"security_probe"));
        assert!(!contains(&bytes, b"BX_SSH_PLAINTEXT_CANARY_7E91"));
    }

    #[test]
    fn failed_migration_rolls_back_schema_and_version() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.db");
        let key = DataKey::generate().unwrap();
        let mut database = EncryptedDatabase::open(&path, &key).unwrap();
        database
            .apply_migrations(&[Migration::new(1, "CREATE TABLE stable (id INTEGER);")])
            .unwrap();

        let error = database
            .apply_migrations(&[
                Migration::new(1, "CREATE TABLE stable (id INTEGER);"),
                Migration::new(
                    2,
                    "CREATE TABLE should_rollback (id INTEGER); THIS IS NOT SQL;",
                ),
            ])
            .unwrap_err();
        assert!(matches!(
            error,
            PersistenceError::MigrationFailed { version: 2, .. }
        ));
        assert_eq!(database.user_version().unwrap(), 1);
        let table_count: i64 = database
            .connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name = 'should_rollback'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
    }

    #[test]
    fn rejects_unordered_migrations_before_running_them() {
        let directory = tempdir().unwrap();
        let key = DataKey::generate().unwrap();
        let mut database = EncryptedDatabase::open(directory.path().join("data.db"), &key).unwrap();

        let error = database
            .apply_migrations(&[
                Migration::new(2, "SELECT 1;"),
                Migration::new(2, "SELECT 1;"),
            ])
            .unwrap_err();
        assert!(matches!(error, PersistenceError::InvalidMigrationOrder));
    }

    #[test]
    fn refuses_to_open_a_schema_created_by_a_newer_application() {
        let directory = tempdir().unwrap();
        let key = DataKey::generate().unwrap();
        let mut database = EncryptedDatabase::open(directory.path().join("data.db"), &key).unwrap();
        database
            .connection
            .pragma_update(None, "user_version", 2)
            .unwrap();

        let error = database
            .apply_migrations(&[Migration::new(1, "SELECT 1;")])
            .unwrap_err();
        assert!(matches!(
            error,
            PersistenceError::DatabaseVersionTooNew {
                actual: 2,
                supported: 1
            }
        ));
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }
}
