use std::collections::HashSet;
use std::fmt;

use bx_contracts::{
    AuthMethod, ConnectionCatalog, ConnectionConfig, ConnectionDetails, ConnectionGroup,
    ConnectionListItem, ConnectionSettingsLayers, ConnectionSettingsOverride,
    ConnectionSettingsScope, ConnectionSettingsSnapshot, HostKeyInfo,
};
use rusqlite::{params, OptionalExtension, Row, Transaction};

use crate::{EncryptedDatabase, PersistenceError, Result, APPLICATION_MIGRATIONS};

const CONNECT_TIMEOUT_KEY: &str = "connection.connectTimeoutSecs";
const KEEP_ALIVE_KEY: &str = "connection.keepAliveSecs";

const CONNECTION_LIST_SQL: &str = "
    SELECT c.id, c.group_id, c.name, c.host, c.port, c.username, c.notes, c.color,
           c.auth_method, c.credential_ref, c.key_reference_id, c.is_favorite,
           c.sort_order, c.revision, r.last_connected_at,
           COALESCE(r.successful_connection_count, 0)
    FROM connections c
    LEFT JOIN recent_connections r ON r.connection_id = c.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.group_id, c.is_favorite DESC, c.sort_order, c.name, c.id
";

const CONNECTION_GET_SQL: &str = "
    SELECT c.id, c.group_id, c.name, c.host, c.port, c.username, c.notes, c.color,
           c.auth_method, c.credential_ref, c.key_reference_id, c.is_favorite,
           c.sort_order, c.revision, r.last_connected_at,
           COALESCE(r.successful_connection_count, 0)
    FROM connections c
    LEFT JOIN recent_connections r ON r.connection_id = c.id
    WHERE c.id = ?1 AND c.deleted_at IS NULL
";

pub struct ConnectionRepository {
    database: EncryptedDatabase,
}

/// A private-key reference resolved from the encrypted connection database.
///
/// The encrypted material is only consumed by the Rust desktop command layer and
/// is intentionally not serializable or exposed to the WebView.
pub struct PrivateKeyReference {
    pub id: String,
    pub storage_kind: String,
    pub file_path: Option<String>,
    pub encrypted_material: Option<Vec<u8>>,
    pub material_key_ref: Option<String>,
    pub passphrase_credential_ref: Option<String>,
    pub public_key_algorithm: Option<String>,
    pub fingerprint_sha256: Option<String>,
    pub comment: Option<String>,
}

impl fmt::Debug for PrivateKeyReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivateKeyReference")
            .field("id", &self.id)
            .field("storage_kind", &self.storage_kind)
            .field("file_path", &self.file_path)
            .field("encrypted_material", &"[REDACTED]")
            .field("material_key_ref", &self.material_key_ref)
            .field("passphrase_credential_ref", &self.passphrase_credential_ref)
            .field("public_key_algorithm", &self.public_key_algorithm)
            .field("fingerprint_sha256", &self.fingerprint_sha256)
            .field("comment", &self.comment)
            .finish()
    }
}

impl fmt::Debug for ConnectionRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConnectionRepository([REDACTED])")
    }
}

impl ConnectionRepository {
    pub fn new(mut database: EncryptedDatabase) -> Result<Self> {
        database.apply_migrations(APPLICATION_MIGRATIONS)?;
        Ok(Self { database })
    }

    pub fn list_catalog(&self) -> Result<ConnectionCatalog> {
        Ok(ConnectionCatalog {
            groups: self.list_groups()?,
            connections: self.list_connections()?,
        })
    }

    pub fn get_connection(&self, id: &str) -> Result<Option<ConnectionDetails>> {
        if id.trim().is_empty() {
            return Err(PersistenceError::InvalidConnectionConfiguration);
        }
        let mut statement = self
            .database
            .connection()
            .prepare(CONNECTION_GET_SQL)
            .map_err(|source| database_operation("prepare a connection query", source))?;
        let raw = statement
            .query_row([id], RawConnection::from_row)
            .optional()
            .map_err(|source| database_operation("query a connection", source))?;
        let Some(connection) = raw.map(RawConnection::into_list_item).transpose()? else {
            return Ok(None);
        };
        let layers = self
            .load_settings_layers(&connection.config.id, connection.config.group_id.as_deref())?;
        let resolved = layers.resolve();
        Ok(Some(ConnectionDetails {
            connection,
            settings: ConnectionSettingsSnapshot { layers, resolved },
        }))
    }

    pub fn list_host_fingerprints(&self, host: &str, port: u16) -> Result<Vec<HostKeyInfo>> {
        validate_host_endpoint(host, port)?;
        let mut statement = self
            .database
            .connection()
            .prepare(
                "SELECT key_algorithm, fingerprint_sha256
                 FROM host_fingerprints
                 WHERE host = ?1 COLLATE NOCASE AND port = ?2
                 ORDER BY id",
            )
            .map_err(|source| database_operation("prepare a host fingerprint query", source))?;
        let rows = statement
            .query_map(params![host.trim(), port], |row| {
                Ok(HostKeyInfo::new(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(|source| database_operation("query host fingerprints", source))?;
        rows.map(|row| row.map_err(|source| database_operation("read a host fingerprint", source)))
            .collect()
    }

    pub fn get_private_key_reference(&self, id: &str) -> Result<Option<PrivateKeyReference>> {
        validate_id(id)?;
        let mut statement = self
            .database
            .connection()
            .prepare(
                "SELECT id, storage_kind, file_path, encrypted_material, material_key_ref,
                        passphrase_credential_ref, public_key_algorithm, fingerprint_sha256,
                        comment
                 FROM key_references
                 WHERE id = ?1",
            )
            .map_err(|source| database_operation("prepare a private key query", source))?;
        statement
            .query_row([id], |row| {
                Ok(PrivateKeyReference {
                    id: row.get(0)?,
                    storage_kind: row.get(1)?,
                    file_path: row.get(2)?,
                    encrypted_material: row.get(3)?,
                    material_key_ref: row.get(4)?,
                    passphrase_credential_ref: row.get(5)?,
                    public_key_algorithm: row.get(6)?,
                    fingerprint_sha256: row.get(7)?,
                    comment: row.get(8)?,
                })
            })
            .optional()
            .map_err(|source| database_operation("query a private key", source))
    }

    pub fn trust_host_fingerprint(
        &mut self,
        host: &str,
        port: u16,
        host_key: &HostKeyInfo,
        now_ms: u64,
    ) -> Result<()> {
        validate_host_endpoint(host, port)?;
        validate_host_key(host_key)?;
        let now = timestamp_to_i64(now_ms)?;
        let host = host.trim();
        let transaction = self
            .database
            .transaction()
            .map_err(|source| database_operation("start a host fingerprint transaction", source))?;
        let mut statement = transaction
            .prepare(
                "SELECT key_algorithm, fingerprint_sha256
                 FROM host_fingerprints
                 WHERE host = ?1 COLLATE NOCASE AND port = ?2",
            )
            .map_err(|source| {
                database_operation("prepare a host fingerprint conflict query", source)
            })?;
        let stored = statement
            .query_map(params![host, port], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|source| database_operation("query host fingerprint conflicts", source))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|source| database_operation("read host fingerprint conflicts", source))?;
        drop(statement);

        if stored.iter().any(|(algorithm, fingerprint)| {
            algorithm != &host_key.algorithm || fingerprint != &host_key.fingerprint_sha256
        }) {
            return Err(PersistenceError::HostFingerprintConflict);
        }

        transaction
            .execute(
                "INSERT INTO host_fingerprints
                 (id, host, port, key_algorithm, fingerprint_sha256, first_seen_at,
                  trusted_at, last_verified_at)
                 VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?5, ?5)
                 ON CONFLICT(host, port, key_algorithm) DO UPDATE SET
                    last_verified_at = excluded.last_verified_at,
                    revision = host_fingerprints.revision + 1",
                params![
                    host,
                    port,
                    host_key.algorithm,
                    host_key.fingerprint_sha256,
                    now
                ],
            )
            .map_err(|source| database_operation("save a host fingerprint", source))?;
        transaction
            .commit()
            .map_err(|source| database_operation("commit a host fingerprint", source))?;
        Ok(())
    }

    pub fn save_group(&mut self, group: &ConnectionGroup, now_ms: u64) -> Result<()> {
        group
            .validate()
            .map_err(|_| PersistenceError::InvalidConnectionConfiguration)?;
        let now = timestamp_to_i64(now_ms)?;
        self.database
            .connection()
            .execute(
                "INSERT INTO connection_groups
                 (id, name, color, sort_order, is_collapsed, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color,
                    sort_order = excluded.sort_order,
                    is_collapsed = excluded.is_collapsed,
                    updated_at = excluded.updated_at,
                    revision = connection_groups.revision + 1",
                params![
                    group.id,
                    group.name,
                    group.color,
                    group.sort_order,
                    group.is_collapsed,
                    now
                ],
            )
            .map_err(|source| database_operation("save a connection group", source))?;
        Ok(())
    }

    pub fn delete_group(&mut self, id: &str, now_ms: u64) -> Result<bool> {
        validate_id(id)?;
        let now = timestamp_to_i64(now_ms)?;
        let transaction = self
            .database
            .transaction()
            .map_err(|source| database_operation("start a group deletion transaction", source))?;
        transaction
            .execute(
                "UPDATE connections
                 SET group_id = NULL,
                     updated_at = ?2,
                     revision = revision + 1
                 WHERE group_id = ?1",
                params![id, now],
            )
            .map_err(|source| database_operation("ungroup connections", source))?;
        let changed = transaction
            .execute("DELETE FROM connection_groups WHERE id = ?1", [id])
            .map_err(|source| database_operation("delete a connection group", source))?;
        transaction
            .commit()
            .map_err(|source| database_operation("commit a group deletion transaction", source))?;
        Ok(changed > 0)
    }

    pub fn set_group_collapsed(
        &mut self,
        id: &str,
        is_collapsed: bool,
        now_ms: u64,
    ) -> Result<bool> {
        validate_id(id)?;
        let now = timestamp_to_i64(now_ms)?;
        let changed = self
            .database
            .connection()
            .execute(
                "UPDATE connection_groups
                 SET is_collapsed = ?2,
                     updated_at = ?3,
                     revision = revision + 1
                 WHERE id = ?1",
                params![id, is_collapsed, now],
            )
            .map_err(|source| database_operation("update group collapse state", source))?;
        Ok(changed > 0)
    }

    pub fn reorder_groups(&mut self, ids: &[String], now_ms: u64) -> Result<()> {
        validate_order_ids(ids)?;
        let now = timestamp_to_i64(now_ms)?;
        let transaction = self
            .database
            .transaction()
            .map_err(|source| database_operation("start a group ordering transaction", source))?;
        let stored_ids = query_ids(
            &transaction,
            "SELECT id FROM connection_groups ORDER BY id",
            [],
            "query connection groups for ordering",
        )?;
        validate_complete_order(&stored_ids, ids)?;
        for (sort_order, id) in ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE connection_groups
                     SET sort_order = ?2,
                         updated_at = ?3,
                         revision = revision + 1
                     WHERE id = ?1",
                    params![id, usize_to_i64(sort_order)?, now],
                )
                .map_err(|source| database_operation("reorder connection groups", source))?;
        }
        transaction
            .commit()
            .map_err(|source| database_operation("commit a group ordering transaction", source))
    }

    pub fn save_connection(
        &mut self,
        config: &ConnectionConfig,
        settings: ConnectionSettingsOverride,
        now_ms: u64,
    ) -> Result<()> {
        config
            .validate()
            .map_err(|_| PersistenceError::InvalidConnectionConfiguration)?;
        let now = timestamp_to_i64(now_ms)?;
        let transaction = self
            .database
            .transaction()
            .map_err(|source| database_operation("start a connection transaction", source))?;
        save_connection_record(&transaction, config, settings, now)?;
        transaction
            .commit()
            .map_err(|source| database_operation("commit a connection transaction", source))
    }

    pub fn import_connections(&mut self, configs: &[ConnectionConfig], now_ms: u64) -> Result<()> {
        for config in configs {
            config
                .validate()
                .map_err(|_| PersistenceError::InvalidConnectionConfiguration)?;
        }
        let now = timestamp_to_i64(now_ms)?;
        let transaction = self
            .database
            .transaction()
            .map_err(|source| database_operation("start an OpenSSH import transaction", source))?;
        for config in configs {
            save_connection_record(
                &transaction,
                config,
                ConnectionSettingsOverride::default(),
                now,
            )?;
        }
        transaction
            .commit()
            .map_err(|source| database_operation("commit an OpenSSH import transaction", source))
    }

    pub fn save_settings(
        &mut self,
        scope: &ConnectionSettingsScope,
        settings: ConnectionSettingsOverride,
        now_ms: u64,
    ) -> Result<()> {
        let owner = match scope {
            ConnectionSettingsScope::Global => SettingOwner::Global,
            ConnectionSettingsScope::Group { group_id } if !group_id.trim().is_empty() => {
                SettingOwner::Group(group_id)
            }
            ConnectionSettingsScope::Connection { connection_id }
                if !connection_id.trim().is_empty() =>
            {
                SettingOwner::Connection(connection_id)
            }
            _ => return Err(PersistenceError::InvalidConnectionConfiguration),
        };
        let now = timestamp_to_i64(now_ms)?;
        let transaction = self
            .database
            .transaction()
            .map_err(|source| database_operation("start a settings transaction", source))?;
        apply_settings(&transaction, owner, settings, now)
            .map_err(|source| database_operation("save scoped connection settings", source))?;
        transaction
            .commit()
            .map_err(|source| database_operation("commit a settings transaction", source))
    }

    pub fn delete_connection(&mut self, id: &str, now_ms: u64) -> Result<bool> {
        validate_id(id)?;
        let now = timestamp_to_i64(now_ms)?;
        let changed = self
            .database
            .connection()
            .execute(
                "UPDATE connections
                 SET deleted_at = ?2,
                     updated_at = ?2,
                     revision = revision + 1
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, now],
            )
            .map_err(|source| database_operation("delete a connection", source))?;
        Ok(changed > 0)
    }

    pub fn set_connection_favorite(
        &mut self,
        id: &str,
        is_favorite: bool,
        now_ms: u64,
    ) -> Result<bool> {
        validate_id(id)?;
        let now = timestamp_to_i64(now_ms)?;
        let changed = self
            .database
            .connection()
            .execute(
                "UPDATE connections
                 SET is_favorite = ?2,
                     updated_at = ?3,
                     revision = revision + 1
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, is_favorite, now],
            )
            .map_err(|source| database_operation("update connection favorite state", source))?;
        Ok(changed > 0)
    }

    pub fn reorder_connections(
        &mut self,
        group_id: Option<&str>,
        ids: &[String],
        now_ms: u64,
    ) -> Result<()> {
        if group_id.is_some_and(|id| id.trim().is_empty()) {
            return Err(PersistenceError::InvalidConnectionConfiguration);
        }
        validate_order_ids(ids)?;
        let now = timestamp_to_i64(now_ms)?;
        let transaction = self.database.transaction().map_err(|source| {
            database_operation("start a connection ordering transaction", source)
        })?;
        let stored_ids = query_ids(
            &transaction,
            "SELECT id FROM connections
             WHERE deleted_at IS NULL AND group_id IS ?1
             ORDER BY id",
            [group_id],
            "query connections for ordering",
        )?;
        validate_complete_order(&stored_ids, ids)?;
        for (sort_order, id) in ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE connections
                     SET sort_order = ?2,
                         updated_at = ?3,
                         revision = revision + 1
                     WHERE id = ?1 AND deleted_at IS NULL AND group_id IS ?4",
                    params![id, usize_to_i64(sort_order)?, now, group_id],
                )
                .map_err(|source| database_operation("reorder connections", source))?;
        }
        transaction.commit().map_err(|source| {
            database_operation("commit a connection ordering transaction", source)
        })
    }

    pub fn record_successful_connection(&mut self, id: &str, now_ms: u64) -> Result<bool> {
        if id.trim().is_empty() {
            return Err(PersistenceError::InvalidConnectionConfiguration);
        }
        let now = timestamp_to_i64(now_ms)?;
        let changed = self
            .database
            .connection()
            .execute(
                "INSERT INTO recent_connections
                 (connection_id, last_connected_at, successful_connection_count)
                 SELECT id, ?2, 1
                 FROM connections
                 WHERE id = ?1 AND deleted_at IS NULL
                 ON CONFLICT(connection_id) DO UPDATE SET
                    last_connected_at = excluded.last_connected_at,
                    successful_connection_count = successful_connection_count + 1",
                params![id, now],
            )
            .map_err(|source| database_operation("record a successful connection", source))?;
        Ok(changed > 0)
    }

    fn list_groups(&self) -> Result<Vec<ConnectionGroup>> {
        let mut statement = self
            .database
            .connection()
            .prepare(
                "SELECT id, name, color, sort_order, is_collapsed, revision
                 FROM connection_groups
                 ORDER BY sort_order, name, id",
            )
            .map_err(|source| database_operation("prepare a group query", source))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RawGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    sort_order: row.get(3)?,
                    is_collapsed: row.get(4)?,
                    revision: row.get(5)?,
                })
            })
            .map_err(|source| database_operation("query connection groups", source))?;
        rows.map(|row| {
            row.map_err(|source| database_operation("read a connection group", source))?
                .into_group()
        })
        .collect()
    }

    fn list_connections(&self) -> Result<Vec<ConnectionListItem>> {
        let mut statement = self
            .database
            .connection()
            .prepare(CONNECTION_LIST_SQL)
            .map_err(|source| database_operation("prepare a connection list query", source))?;
        let rows = statement
            .query_map([], RawConnection::from_row)
            .map_err(|source| database_operation("query connections", source))?;
        rows.map(|row| {
            row.map_err(|source| database_operation("read a connection", source))?
                .into_list_item()
        })
        .collect()
    }

    fn load_settings_layers(
        &self,
        connection_id: &str,
        group_id: Option<&str>,
    ) -> Result<ConnectionSettingsLayers> {
        Ok(ConnectionSettingsLayers {
            global: self.load_setting_override(SettingOwner::Global)?,
            group: group_id
                .map(|id| self.load_setting_override(SettingOwner::Group(id)))
                .transpose()?
                .flatten(),
            connection: self.load_setting_override(SettingOwner::Connection(connection_id))?,
        })
    }

    fn load_setting_override(
        &self,
        owner: SettingOwner<'_>,
    ) -> Result<Option<ConnectionSettingsOverride>> {
        let connection = self.database.connection();
        let mut values = match owner {
            SettingOwner::Global => read_setting_rows(
                connection.prepare(
                    "SELECT key, value_json FROM settings
                     WHERE group_id IS NULL AND connection_id IS NULL
                       AND key IN (?1, ?2)",
                ),
                params![CONNECT_TIMEOUT_KEY, KEEP_ALIVE_KEY],
            ),
            SettingOwner::Group(id) => read_setting_rows(
                connection.prepare(
                    "SELECT key, value_json FROM settings
                     WHERE group_id = ?3 AND connection_id IS NULL
                       AND key IN (?1, ?2)",
                ),
                params![CONNECT_TIMEOUT_KEY, KEEP_ALIVE_KEY, id],
            ),
            SettingOwner::Connection(id) => read_setting_rows(
                connection.prepare(
                    "SELECT key, value_json FROM settings
                     WHERE connection_id = ?3 AND group_id IS NULL
                       AND key IN (?1, ?2)",
                ),
                params![CONNECT_TIMEOUT_KEY, KEEP_ALIVE_KEY, id],
            ),
        }?;
        if values.connect_timeout_secs.is_none() && values.keep_alive_secs.is_none() {
            Ok(None)
        } else {
            Ok(Some(std::mem::take(&mut values)))
        }
    }
}

#[derive(Clone, Copy)]
enum SettingOwner<'a> {
    Global,
    Group(&'a str),
    Connection(&'a str),
}

struct RawGroup {
    id: String,
    name: String,
    color: Option<String>,
    sort_order: i64,
    is_collapsed: i64,
    revision: i64,
}

impl RawGroup {
    fn into_group(self) -> Result<ConnectionGroup> {
        Ok(ConnectionGroup {
            id: self.id,
            name: self.name,
            color: self.color,
            sort_order: stored_u32(self.sort_order, "connection group")?,
            is_collapsed: stored_bool(self.is_collapsed, "connection group")?,
            revision: stored_u64(self.revision, "connection group")?,
        })
    }
}

struct RawConnection {
    id: String,
    group_id: Option<String>,
    name: String,
    host: String,
    port: i64,
    username: String,
    notes: Option<String>,
    color: Option<String>,
    auth_method: String,
    credential_ref: Option<String>,
    key_reference_id: Option<String>,
    is_favorite: i64,
    sort_order: i64,
    revision: i64,
    last_connected_at: Option<i64>,
    successful_connection_count: i64,
}

impl RawConnection {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            group_id: row.get(1)?,
            name: row.get(2)?,
            host: row.get(3)?,
            port: row.get(4)?,
            username: row.get(5)?,
            notes: row.get(6)?,
            color: row.get(7)?,
            auth_method: row.get(8)?,
            credential_ref: row.get(9)?,
            key_reference_id: row.get(10)?,
            is_favorite: row.get(11)?,
            sort_order: row.get(12)?,
            revision: row.get(13)?,
            last_connected_at: row.get(14)?,
            successful_connection_count: row.get(15)?,
        })
    }

    fn into_list_item(self) -> Result<ConnectionListItem> {
        let auth_method = AuthMethod::from_database_value(&self.auth_method).ok_or(
            PersistenceError::InvalidStoredRecord {
                entity: "connection",
            },
        )?;
        let config = ConnectionConfig {
            id: self.id,
            group_id: self.group_id,
            name: self.name,
            host: self.host,
            port: u16::try_from(self.port).map_err(|_| PersistenceError::InvalidStoredRecord {
                entity: "connection",
            })?,
            username: self.username,
            notes: self.notes,
            color: self.color,
            auth_method,
            credential_ref: self.credential_ref,
            key_reference_id: self.key_reference_id,
        };
        config
            .validate()
            .map_err(|_| PersistenceError::InvalidStoredRecord {
                entity: "connection",
            })?;
        Ok(ConnectionListItem {
            config,
            is_favorite: stored_bool(self.is_favorite, "connection")?,
            sort_order: stored_u32(self.sort_order, "connection")?,
            last_connected_at: self
                .last_connected_at
                .map(|value| stored_u64(value, "recent connection"))
                .transpose()?,
            successful_connection_count: stored_u64(
                self.successful_connection_count,
                "recent connection",
            )?,
            revision: stored_u64(self.revision, "connection")?,
        })
    }
}

fn save_connection_record(
    transaction: &Transaction<'_>,
    config: &ConnectionConfig,
    settings: ConnectionSettingsOverride,
    now: i64,
) -> Result<()> {
    transaction
        .execute(
            "INSERT INTO connections
             (id, group_id, key_reference_id, name, host, port, username, notes, color,
              auth_method, credential_ref, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                COALESCE((
                    SELECT MAX(sort_order) + 1 FROM connections
                    WHERE deleted_at IS NULL AND group_id IS ?2
                ), 0), ?12, ?12)
             ON CONFLICT(id) DO UPDATE SET
                group_id = excluded.group_id,
                key_reference_id = excluded.key_reference_id,
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                notes = excluded.notes,
                color = excluded.color,
                auth_method = excluded.auth_method,
                credential_ref = excluded.credential_ref,
                sort_order = CASE
                    WHEN connections.group_id IS excluded.group_id
                         AND connections.deleted_at IS NULL
                    THEN connections.sort_order
                    ELSE excluded.sort_order
                END,
                updated_at = excluded.updated_at,
                deleted_at = NULL,
                revision = connections.revision + 1",
            params![
                config.id,
                config.group_id,
                config.key_reference_id,
                config.name,
                config.host,
                config.port,
                config.username,
                config.notes,
                config.color,
                config.auth_method.database_value(),
                config.credential_ref,
                now,
            ],
        )
        .map_err(|source| database_operation("save a connection", source))?;
    apply_settings(
        transaction,
        SettingOwner::Connection(&config.id),
        settings,
        now,
    )
    .map_err(|source| database_operation("save connection settings", source))
}

fn apply_settings(
    transaction: &Transaction<'_>,
    owner: SettingOwner<'_>,
    settings: ConnectionSettingsOverride,
    now: i64,
) -> rusqlite::Result<()> {
    write_setting(
        transaction,
        owner,
        CONNECT_TIMEOUT_KEY,
        settings.connect_timeout_secs,
        now,
    )?;
    write_setting(
        transaction,
        owner,
        KEEP_ALIVE_KEY,
        settings.keep_alive_secs,
        now,
    )
}

fn write_setting(
    transaction: &Transaction<'_>,
    owner: SettingOwner<'_>,
    key: &str,
    value: Option<u32>,
    now: i64,
) -> rusqlite::Result<()> {
    match (owner, value) {
        (SettingOwner::Global, Some(value)) => transaction.execute(
            "INSERT INTO settings (key, value_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(key) WHERE group_id IS NULL AND connection_id IS NULL
             DO UPDATE SET value_json = excluded.value_json,
                           updated_at = excluded.updated_at,
                           revision = settings.revision + 1",
            params![key, value.to_string(), now],
        ),
        (SettingOwner::Group(id), Some(value)) => transaction.execute(
            "INSERT INTO settings (key, value_json, group_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(group_id, key) WHERE group_id IS NOT NULL AND connection_id IS NULL
             DO UPDATE SET value_json = excluded.value_json,
                           updated_at = excluded.updated_at,
                           revision = settings.revision + 1",
            params![key, value.to_string(), id, now],
        ),
        (SettingOwner::Connection(id), Some(value)) => transaction.execute(
            "INSERT INTO settings (key, value_json, connection_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(connection_id, key) WHERE connection_id IS NOT NULL AND group_id IS NULL
             DO UPDATE SET value_json = excluded.value_json,
                           updated_at = excluded.updated_at,
                           revision = settings.revision + 1",
            params![key, value.to_string(), id, now],
        ),
        (SettingOwner::Global, None) => transaction.execute(
            "DELETE FROM settings
             WHERE key = ?1 AND group_id IS NULL AND connection_id IS NULL",
            [key],
        ),
        (SettingOwner::Group(id), None) => transaction.execute(
            "DELETE FROM settings
             WHERE key = ?1 AND group_id = ?2 AND connection_id IS NULL",
            params![key, id],
        ),
        (SettingOwner::Connection(id), None) => transaction.execute(
            "DELETE FROM settings
             WHERE key = ?1 AND connection_id = ?2 AND group_id IS NULL",
            params![key, id],
        ),
    }
    .map(|_| ())
}

fn read_setting_rows<P>(
    statement: rusqlite::Result<rusqlite::Statement<'_>>,
    parameters: P,
) -> Result<ConnectionSettingsOverride>
where
    P: rusqlite::Params,
{
    let mut statement = statement
        .map_err(|source| database_operation("prepare scoped connection settings", source))?;
    let rows = statement
        .query_map(parameters, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|source| database_operation("query scoped connection settings", source))?;
    let mut values = ConnectionSettingsOverride::default();
    for row in rows {
        let (key, value_json) =
            row.map_err(|source| database_operation("read scoped connection settings", source))?;
        let value = serde_json::from_str::<u32>(&value_json).map_err(|_| {
            PersistenceError::InvalidStoredRecord {
                entity: "connection setting",
            }
        })?;
        match key.as_str() {
            CONNECT_TIMEOUT_KEY => values.connect_timeout_secs = Some(value),
            KEEP_ALIVE_KEY => values.keep_alive_secs = Some(value),
            _ => {}
        }
    }
    Ok(values)
}

fn timestamp_to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| PersistenceError::InvalidTimestamp)
}

fn usize_to_i64(value: usize) -> Result<i64> {
    i64::try_from(value).map_err(|_| PersistenceError::InvalidConnectionConfiguration)
}

fn validate_id(id: &str) -> Result<()> {
    if id.trim().is_empty() {
        Err(PersistenceError::InvalidConnectionConfiguration)
    } else {
        Ok(())
    }
}

fn validate_order_ids(ids: &[String]) -> Result<()> {
    let mut unique_ids = HashSet::with_capacity(ids.len());
    if ids
        .iter()
        .any(|id| id.trim().is_empty() || !unique_ids.insert(id.as_str()))
    {
        return Err(PersistenceError::InvalidConnectionConfiguration);
    }
    Ok(())
}

fn validate_complete_order(stored_ids: &[String], ids: &[String]) -> Result<()> {
    if stored_ids.len() != ids.len() {
        return Err(PersistenceError::InvalidConnectionConfiguration);
    }
    let requested_ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if stored_ids
        .iter()
        .any(|id| !requested_ids.contains(id.as_str()))
    {
        return Err(PersistenceError::InvalidConnectionConfiguration);
    }
    Ok(())
}

fn query_ids<P: rusqlite::Params>(
    transaction: &Transaction<'_>,
    sql: &str,
    params: P,
    operation: &'static str,
) -> Result<Vec<String>> {
    let mut statement = transaction
        .prepare(sql)
        .map_err(|source| database_operation(operation, source))?;
    let rows = statement
        .query_map(params, |row| row.get(0))
        .map_err(|source| database_operation(operation, source))?;
    rows.map(|row| row.map_err(|source| database_operation(operation, source)))
        .collect()
}

fn stored_u64(value: i64, entity: &'static str) -> Result<u64> {
    u64::try_from(value).map_err(|_| PersistenceError::InvalidStoredRecord { entity })
}

fn stored_u32(value: i64, entity: &'static str) -> Result<u32> {
    u32::try_from(value).map_err(|_| PersistenceError::InvalidStoredRecord { entity })
}

fn stored_bool(value: i64, entity: &'static str) -> Result<bool> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(PersistenceError::InvalidStoredRecord { entity }),
    }
}

fn database_operation(operation: &'static str, source: rusqlite::Error) -> PersistenceError {
    PersistenceError::DatabaseOperation { operation, source }
}

fn validate_host_endpoint(host: &str, port: u16) -> Result<()> {
    if host.trim().is_empty() || port == 0 {
        Err(PersistenceError::InvalidConnectionConfiguration)
    } else {
        Ok(())
    }
}

fn validate_host_key(host_key: &HostKeyInfo) -> Result<()> {
    let fingerprint = host_key.fingerprint_sha256.strip_prefix("SHA256:");
    if host_key.algorithm.trim().is_empty()
        || !fingerprint.is_some_and(|value| {
            value.len() == 43
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        })
    {
        Err(PersistenceError::InvalidStoredRecord {
            entity: "host fingerprint",
        })
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::ops::{Deref, DerefMut};

    use bx_contracts::{
        ConnectionSettings, HostKeyInfo, DEFAULT_CONNECT_TIMEOUT_SECS, DEFAULT_KEEP_ALIVE_SECS,
    };
    use tempfile::{tempdir, TempDir};

    use super::*;
    use crate::DataKey;

    #[test]
    fn initializes_schema_and_lists_an_empty_catalog() {
        let repository = test_repository();

        assert_eq!(
            repository.list_catalog().unwrap(),
            ConnectionCatalog {
                groups: Vec::new(),
                connections: Vec::new(),
            }
        );
    }

    #[test]
    fn persists_known_hosts_by_case_insensitive_endpoint_and_non_standard_port() {
        let mut repository = test_repository();
        let host_key = HostKeyInfo::new(
            "ssh-ed25519",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert!(repository
            .list_host_fingerprints("Example.COM", 2222)
            .unwrap()
            .is_empty());
        repository
            .trust_host_fingerprint("Example.COM", 2222, &host_key, 1000)
            .unwrap();
        assert_eq!(
            repository
                .list_host_fingerprints("example.com", 2222)
                .unwrap(),
            vec![host_key.clone()]
        );
        assert!(repository
            .list_host_fingerprints("example.com", 22)
            .unwrap()
            .is_empty());

        repository
            .trust_host_fingerprint("example.com", 2222, &host_key, 2000)
            .unwrap();
        let count: i64 = repository
            .database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM host_fingerprints WHERE host = 'example.com' AND port = 2222",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn reads_private_key_references_without_exposing_material_in_debug() {
        let repository = test_repository();
        repository
            .database
            .connection()
            .execute(
                "INSERT INTO key_references
                 (id, name, storage_kind, file_path, public_key_algorithm,
                  fingerprint_sha256, created_at, updated_at)
                 VALUES ('key-1', 'Deploy key', 'file', '/keys/deploy', 'ssh-ed25519',
                         'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, 1)",
                [],
            )
            .unwrap();

        let reference = repository
            .get_private_key_reference("key-1")
            .unwrap()
            .unwrap();
        assert_eq!(reference.file_path.as_deref(), Some("/keys/deploy"));
        assert_eq!(
            reference.public_key_algorithm.as_deref(),
            Some("ssh-ed25519")
        );
        assert!(!format!("{reference:?}").contains("PRIVATE_KEY_MATERIAL"));
        assert!(repository
            .get_private_key_reference("missing")
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_known_host_replacement_and_invalid_openssh_fingerprints() {
        let mut repository = test_repository();
        let original = HostKeyInfo::new(
            "ssh-ed25519",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
        repository
            .trust_host_fingerprint("example.com", 22, &original, 1000)
            .unwrap();

        let changed = HostKeyInfo::new(
            "ssh-ed25519",
            "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        );
        assert!(matches!(
            repository.trust_host_fingerprint("example.com", 22, &changed, 2000),
            Err(PersistenceError::HostFingerprintConflict)
        ));
        let invalid = HostKeyInfo::new("ssh-ed25519", "MD5:aa:bb");
        assert!(matches!(
            repository.trust_host_fingerprint("example.com", 22, &invalid, 2000),
            Err(PersistenceError::InvalidStoredRecord { .. })
        ));
    }

    #[test]
    fn saves_and_queries_connections_without_exposing_secret_values() {
        let mut repository = test_repository();
        let mut config =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        config.credential_ref = Some("credential:connection-1".to_owned());

        repository
            .save_connection(
                &config,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(12),
                    keep_alive_secs: Some(45),
                },
                1_700_000_000_000,
            )
            .unwrap();
        repository
            .record_successful_connection("connection-1", 1_700_000_001_000)
            .unwrap();

        let details = repository.get_connection("connection-1").unwrap().unwrap();
        assert_eq!(details.connection.config, config);
        assert_eq!(details.connection.successful_connection_count, 1);
        assert_eq!(
            details.settings.resolved,
            ConnectionSettings {
                connect_timeout_secs: 12,
                keep_alive_secs: 45,
            }
        );
        let serialized = serde_json::to_value(&details).unwrap();
        assert!(!contains_json_key(&serialized, "password"));
        assert!(!contains_json_key(&serialized, "passphrase"));
    }

    #[test]
    fn records_recent_connection_time_and_count_only_for_saved_connections() {
        let mut repository = test_repository();
        let config = ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        repository
            .save_connection(&config, ConnectionSettingsOverride::default(), 1000)
            .unwrap();

        assert!(repository
            .record_successful_connection("connection-1", 2000)
            .unwrap());
        assert!(repository
            .record_successful_connection("connection-1", 3000)
            .unwrap());
        assert!(!repository
            .record_successful_connection("missing-connection", 4000)
            .unwrap());

        let item = repository.list_catalog().unwrap().connections.remove(0);
        assert_eq!(item.last_connected_at, Some(3000));
        assert_eq!(item.successful_connection_count, 2);

        repository.delete_connection("connection-1", 5000).unwrap();
        assert!(!repository
            .record_successful_connection("connection-1", 6000)
            .unwrap());
    }

    #[test]
    fn persists_group_collapse_color_and_order() {
        let mut repository = test_repository();
        let first = test_group("group-first", "First", "#1677FF", 1);
        let second = test_group("group-second", "Second", "#52C41A", 0);
        repository.save_group(&first, 1000).unwrap();
        repository.save_group(&second, 1001).unwrap();

        assert!(repository
            .set_group_collapsed("group-first", true, 1002)
            .unwrap());
        repository
            .reorder_groups(&["group-first".to_owned(), "group-second".to_owned()], 1003)
            .unwrap();

        let catalog = repository.list_catalog().unwrap();
        assert_eq!(
            catalog
                .groups
                .iter()
                .map(|group| group.id.as_str())
                .collect::<Vec<_>>(),
            vec!["group-first", "group-second"]
        );
        assert_eq!(catalog.groups[0].color.as_deref(), Some("#1677FF"));
        assert!(catalog.groups[0].is_collapsed);
        assert_eq!(catalog.groups[0].sort_order, 0);
    }

    #[test]
    fn favorites_connections_and_orders_each_group_transactionally() {
        let mut repository = test_repository();
        repository
            .save_group(&test_group("group-1", "Production", "#1677FF", 0), 1000)
            .unwrap();
        for (id, name) in [("connection-1", "One"), ("connection-2", "Two")] {
            let mut config = ConnectionConfig::new(id, name, "example.com", "alice");
            config.group_id = Some("group-1".to_owned());
            repository
                .save_connection(&config, ConnectionSettingsOverride::default(), 1001)
                .unwrap();
        }

        repository
            .reorder_connections(
                Some("group-1"),
                &["connection-2".to_owned(), "connection-1".to_owned()],
                1002,
            )
            .unwrap();
        assert!(repository
            .set_connection_favorite("connection-1", true, 1003)
            .unwrap());

        let catalog = repository.list_catalog().unwrap();
        assert_eq!(catalog.connections[0].config.id, "connection-1");
        assert!(catalog.connections[0].is_favorite);
        assert_eq!(
            catalog
                .connections
                .iter()
                .find(|item| item.config.id == "connection-2")
                .unwrap()
                .sort_order,
            0
        );

        let before = catalog.connections;
        assert!(repository
            .reorder_connections(
                Some("group-1"),
                &["connection-1".to_owned(), "connection-1".to_owned()],
                1004,
            )
            .is_err());
        assert_eq!(repository.list_catalog().unwrap().connections, before);
    }

    #[test]
    fn deleting_a_group_preserves_connections_as_ungrouped() {
        let mut repository = test_repository();
        repository
            .save_group(&test_group("group-1", "Production", "#1677FF", 0), 1000)
            .unwrap();
        let mut config =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        config.group_id = Some("group-1".to_owned());
        repository
            .save_connection(&config, ConnectionSettingsOverride::default(), 1001)
            .unwrap();

        assert!(repository.delete_group("group-1", 1002).unwrap());
        let catalog = repository.list_catalog().unwrap();
        assert!(catalog.groups.is_empty());
        assert_eq!(catalog.connections.len(), 1);
        assert_eq!(catalog.connections[0].config.group_id, None);
    }

    #[test]
    fn resolves_global_group_and_connection_settings_in_order() {
        let mut repository = test_repository();
        let group = ConnectionGroup {
            id: "group-1".to_owned(),
            name: "Production".to_owned(),
            color: Some("#009688".to_owned()),
            sort_order: 0,
            is_collapsed: false,
            revision: 1,
        };
        repository.save_group(&group, 1000).unwrap();
        repository
            .save_settings(
                &ConnectionSettingsScope::Global,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(20),
                    keep_alive_secs: Some(40),
                },
                1000,
            )
            .unwrap();
        repository
            .save_settings(
                &ConnectionSettingsScope::Group {
                    group_id: group.id.clone(),
                },
                ConnectionSettingsOverride {
                    connect_timeout_secs: None,
                    keep_alive_secs: Some(50),
                },
                1001,
            )
            .unwrap();
        let mut config =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        config.group_id = Some(group.id.clone());
        repository
            .save_connection(
                &config,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(5),
                    keep_alive_secs: None,
                },
                1002,
            )
            .unwrap();

        let details = repository.get_connection("connection-1").unwrap().unwrap();
        assert_eq!(
            details.settings.layers.global.unwrap().connect_timeout_secs,
            Some(20)
        );
        assert_eq!(
            details.settings.layers.group.unwrap().keep_alive_secs,
            Some(50)
        );
        assert_eq!(
            details.settings.resolved,
            ConnectionSettings {
                connect_timeout_secs: 5,
                keep_alive_secs: 50,
            }
        );
    }

    #[test]
    fn updating_a_connection_is_atomic_and_increments_revision() {
        let mut repository = test_repository();
        let mut config =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        repository
            .save_connection(&config, ConnectionSettingsOverride::default(), 1000)
            .unwrap();
        config.name = "Production primary".to_owned();
        repository
            .save_connection(
                &config,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(15),
                    keep_alive_secs: None,
                },
                1001,
            )
            .unwrap();

        let details = repository.get_connection("connection-1").unwrap().unwrap();
        assert_eq!(details.connection.config.name, "Production primary");
        assert_eq!(details.connection.revision, 2);
        assert_eq!(details.settings.resolved.connect_timeout_secs, 15);
        assert_eq!(
            details.settings.resolved.keep_alive_secs,
            DEFAULT_KEEP_ALIVE_SECS
        );
        assert_ne!(
            details.settings.resolved.connect_timeout_secs,
            DEFAULT_CONNECT_TIMEOUT_SECS
        );
    }

    #[test]
    fn soft_deletes_and_restores_a_connection_without_touching_its_settings() {
        let mut repository = test_repository();
        let config = ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        repository
            .save_connection(
                &config,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(15),
                    keep_alive_secs: Some(45),
                },
                1000,
            )
            .unwrap();

        assert!(repository.delete_connection("connection-1", 1001).unwrap());
        assert!(!repository.delete_connection("connection-1", 1002).unwrap());
        assert!(repository.get_connection("connection-1").unwrap().is_none());
        assert!(repository.list_catalog().unwrap().connections.is_empty());

        repository
            .save_connection(
                &config,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(20),
                    keep_alive_secs: None,
                },
                1003,
            )
            .unwrap();
        let restored = repository.get_connection("connection-1").unwrap().unwrap();
        assert_eq!(restored.settings.resolved.connect_timeout_secs, 20);
        assert_eq!(
            restored.settings.resolved.keep_alive_secs,
            DEFAULT_KEEP_ALIVE_SECS
        );
    }

    #[test]
    fn rejects_invalid_foreign_keys_without_writing_a_partial_connection() {
        let mut repository = test_repository();
        let mut config =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        config.group_id = Some("missing-group".to_owned());

        assert!(repository
            .save_connection(
                &config,
                ConnectionSettingsOverride {
                    connect_timeout_secs: Some(15),
                    keep_alive_secs: Some(30),
                },
                1000,
            )
            .is_err());
        assert!(repository.get_connection("connection-1").unwrap().is_none());
    }

    struct TestRepository {
        repository: ConnectionRepository,
        _directory: TempDir,
    }

    impl Deref for TestRepository {
        type Target = ConnectionRepository;

        fn deref(&self) -> &Self::Target {
            &self.repository
        }
    }

    impl DerefMut for TestRepository {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.repository
        }
    }

    fn test_repository() -> TestRepository {
        let directory = tempdir().unwrap();
        let key = DataKey::generate().unwrap();
        let database = EncryptedDatabase::open(directory.path().join("data.db"), &key).unwrap();
        TestRepository {
            repository: ConnectionRepository::new(database).unwrap(),
            _directory: directory,
        }
    }

    fn test_group(id: &str, name: &str, color: &str, sort_order: u32) -> ConnectionGroup {
        ConnectionGroup {
            id: id.to_owned(),
            name: name.to_owned(),
            color: Some(color.to_owned()),
            sort_order,
            is_collapsed: false,
            revision: 1,
        }
    }

    fn contains_json_key(value: &serde_json::Value, key: &str) -> bool {
        match value {
            serde_json::Value::Object(values) => {
                values.contains_key(key)
                    || values.values().any(|value| contains_json_key(value, key))
            }
            serde_json::Value::Array(values) => {
                values.iter().any(|value| contains_json_key(value, key))
            }
            _ => false,
        }
    }
}
