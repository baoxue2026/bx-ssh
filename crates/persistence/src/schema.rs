use crate::Migration;

/// Latest application schema stored in SQLite's `user_version` pragma.
pub const LATEST_SCHEMA_VERSION: u32 = 1;

const INITIAL_SCHEMA: &str = include_str!("../migrations/0001_initial.sql");

/// Ordered migrations required to initialize or upgrade the application database.
pub const APPLICATION_MIGRATIONS: &[Migration] =
    &[Migration::new(LATEST_SCHEMA_VERSION, INITIAL_SCHEMA)];

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rusqlite::{Connection, ErrorCode};
    use tempfile::tempdir;

    use super::*;
    use crate::{DataKey, EncryptedDatabase};

    const FINGERPRINT: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn application_migrations_set_the_current_schema_version() {
        let directory = tempdir().unwrap();
        let key = DataKey::generate().unwrap();
        let mut database = EncryptedDatabase::open(directory.path().join("data.db"), &key).unwrap();

        database.apply_migrations(APPLICATION_MIGRATIONS).unwrap();

        assert_eq!(database.user_version().unwrap(), LATEST_SCHEMA_VERSION);
    }

    #[test]
    fn application_migration_versions_are_strictly_increasing() {
        assert!(APPLICATION_MIGRATIONS
            .windows(2)
            .all(|pair| pair[0].version() < pair[1].version()));
        assert_eq!(
            APPLICATION_MIGRATIONS.last().map(|item| item.version()),
            Some(LATEST_SCHEMA_VERSION)
        );
    }

    #[test]
    fn initial_schema_contains_the_phase_one_entities_and_indexes() {
        let connection = migrated_connection();
        let tables = object_names(&connection, "table");
        let indexes = object_names(&connection, "index");

        assert_eq!(
            tables,
            BTreeSet::from([
                "connection_groups".to_owned(),
                "connections".to_owned(),
                "host_fingerprints".to_owned(),
                "key_references".to_owned(),
                "recent_connections".to_owned(),
                "settings".to_owned(),
            ])
        );
        for required in [
            "connections_group_sort_index",
            "connections_favorite_index",
            "connections_host_index",
            "host_fingerprints_verified_index",
            "recent_connections_time_index",
            "settings_global_key_unique",
            "settings_group_key_unique",
            "settings_connection_key_unique",
        ] {
            assert!(indexes.contains(required), "missing index {required}");
        }
    }

    #[test]
    fn settings_enforce_scope_uniqueness_and_follow_owner_lifetimes() {
        let connection = migrated_connection();
        insert_group(&connection);
        insert_password_connection(&connection);

        connection
            .execute(
                "INSERT INTO settings (key, value_json, created_at, updated_at) \
                 VALUES ('connection.timeoutSeconds', '10', 1000, 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO settings \
                 (key, value_json, group_id, created_at, updated_at) \
                 VALUES ('connection.timeoutSeconds', '20', 'group-1', 1000, 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO settings \
                 (key, value_json, connection_id, created_at, updated_at) \
                 VALUES ('connection.timeoutSeconds', '30', 'connection-1', 1000, 1000)",
                [],
            )
            .unwrap();

        let duplicate = connection
            .execute(
                "INSERT INTO settings (key, value_json, created_at, updated_at) \
                 VALUES ('connection.timeoutSeconds', '40', 1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(duplicate);

        let invalid_json = connection
            .execute(
                "INSERT INTO settings (key, value_json, created_at, updated_at) \
                 VALUES ('invalidJson', '{', 1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(invalid_json);

        let ambiguous_scope = connection
            .execute(
                "INSERT INTO settings \
                 (key, value_json, group_id, connection_id, created_at, updated_at) \
                 VALUES ('ambiguousScope', 'true', 'group-1', 'connection-1', 1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(ambiguous_scope);

        connection
            .execute("DELETE FROM connection_groups WHERE id = 'group-1'", [])
            .unwrap();
        assert_eq!(setting_count(&connection), 2);
        let group_id: Option<String> = connection
            .query_row(
                "SELECT group_id FROM connections WHERE id = 'connection-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(group_id, None);

        connection
            .execute("DELETE FROM connections WHERE id = 'connection-1'", [])
            .unwrap();
        assert_eq!(setting_count(&connection), 1);
    }

    #[test]
    fn deletion_rules_protect_key_references_and_host_trust() {
        let connection = migrated_connection();
        insert_group(&connection);
        connection
            .execute(
                "INSERT INTO key_references \
                 (id, name, storage_kind, file_path, created_at, updated_at) \
                 VALUES ('key-1', 'Default key', 'file', 'C:\\Users\\alice\\.ssh\\id_ed25519', 1000, 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO connections \
                 (id, group_id, key_reference_id, name, host, port, username, auth_method, \
                  created_at, updated_at) \
                 VALUES ('connection-1', 'group-1', 'key-1', 'Production', 'example.com', 22, \
                         'alice', 'private_key', 1000, 1000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO recent_connections \
                 (connection_id, last_connected_at, successful_connection_count) \
                 VALUES ('connection-1', 2000, 3)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO host_fingerprints \
                 (id, host, port, key_algorithm, fingerprint_sha256, first_seen_at, trusted_at, \
                  last_verified_at) \
                 VALUES ('fingerprint-1', 'example.com', 22, 'ssh-ed25519', ?1, 1000, 1000, 2000)",
                [FINGERPRINT],
            )
            .unwrap();

        let referenced_key = connection
            .execute("DELETE FROM key_references WHERE id = 'key-1'", [])
            .unwrap_err();
        assert_constraint_violation(referenced_key);

        connection
            .execute("DELETE FROM connections WHERE id = 'connection-1'", [])
            .unwrap();
        assert_eq!(row_count(&connection, "recent_connections"), 0);
        assert_eq!(row_count(&connection, "host_fingerprints"), 1);
        connection
            .execute("DELETE FROM key_references WHERE id = 'key-1'", [])
            .unwrap();
    }

    #[test]
    fn sensitive_material_can_only_be_persisted_as_references_or_ciphertext() {
        let connection = migrated_connection();
        let connection_columns = column_names(&connection, "connections");
        let key_columns = column_names(&connection, "key_references");

        assert!(connection_columns.contains("credential_ref"));
        assert!(!connection_columns.contains("password"));
        assert!(!connection_columns.contains("passphrase"));
        assert!(key_columns.contains("encrypted_material"));
        assert!(key_columns.contains("material_key_ref"));
        assert!(!key_columns.contains("private_key"));

        let invalid_import = connection
            .execute(
                "INSERT INTO key_references \
                 (id, name, storage_kind, encrypted_material, created_at, updated_at) \
                 VALUES ('key-1', 'Imported key', 'imported', X'0102', 1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(invalid_import);

        let incomplete_public_identity = connection
            .execute(
                "INSERT INTO key_references \
                 (id, name, storage_kind, file_path, public_key_algorithm, created_at, updated_at) \
                 VALUES ('key-1', 'File key', 'file', 'id_ed25519', 'ssh-ed25519', 1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(incomplete_public_identity);

        connection
            .execute(
                "INSERT INTO key_references \
                 (id, name, storage_kind, encrypted_material, material_key_ref, created_at, updated_at) \
                 VALUES ('key-1', 'Imported key', 'imported', X'0102', 'credential:key-1', 1000, 1000)",
                [],
            )
            .unwrap();
    }

    #[test]
    fn connection_and_fingerprint_constraints_reject_invalid_records() {
        let connection = migrated_connection();
        insert_group(&connection);

        let invalid_port = connection
            .execute(
                "INSERT INTO connections \
                 (id, name, host, port, username, auth_method, created_at, updated_at) \
                 VALUES ('connection-1', 'Invalid', 'example.com', 65536, 'alice', 'password', \
                         1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(invalid_port);

        let empty_credential_reference = connection
            .execute(
                "INSERT INTO connections \
                 (id, name, host, port, username, auth_method, credential_ref, created_at, updated_at) \
                 VALUES ('connection-1', 'Invalid', 'example.com', 22, 'alice', 'password', '  ', \
                         1000, 1000)",
                [],
            )
            .unwrap_err();
        assert_constraint_violation(empty_credential_reference);

        insert_password_connection(&connection);
        connection
            .execute(
                "INSERT INTO host_fingerprints \
                 (id, host, port, key_algorithm, fingerprint_sha256, first_seen_at, trusted_at, \
                  last_verified_at) \
                 VALUES ('fingerprint-1', 'EXAMPLE.com', 22, 'ssh-ed25519', ?1, 1000, 1000, 1000)",
                [FINGERPRINT],
            )
            .unwrap();
        let changed_fingerprint = format!("SHA256:{}", "B".repeat(43));
        let duplicate_endpoint = connection
            .execute(
                "INSERT INTO host_fingerprints \
                 (id, host, port, key_algorithm, fingerprint_sha256, first_seen_at, trusted_at, \
                  last_verified_at) \
                 VALUES ('fingerprint-2', 'example.COM', 22, 'ssh-ed25519', ?1, 1000, 1000, 1000)",
                [changed_fingerprint],
            )
            .unwrap_err();
        assert_constraint_violation(duplicate_endpoint);
    }

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection.execute_batch(INITIAL_SCHEMA).unwrap();
        connection
    }

    fn insert_group(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO connection_groups \
                 (id, name, created_at, updated_at) VALUES ('group-1', 'Production', 1000, 1000)",
                [],
            )
            .unwrap();
    }

    fn insert_password_connection(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO connections \
                 (id, group_id, name, host, port, username, auth_method, created_at, updated_at) \
                 VALUES ('connection-1', 'group-1', 'Production', 'example.com', 22, 'alice', \
                         'password', 1000, 1000)",
                [],
            )
            .unwrap();
    }

    fn object_names(connection: &Connection, object_type: &str) -> BTreeSet<String> {
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_schema \
                 WHERE type = ?1 AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        statement
            .query_map([object_type], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn column_names(connection: &Connection, table: &str) -> BTreeSet<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        statement
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn setting_count(connection: &Connection) -> i64 {
        row_count(connection, "settings")
    }

    fn row_count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn assert_constraint_violation(error: rusqlite::Error) {
        assert!(matches!(
            error,
            rusqlite::Error::SqliteFailure(sqlite_error, _)
                if sqlite_error.code == ErrorCode::ConstraintViolation
        ));
    }
}
