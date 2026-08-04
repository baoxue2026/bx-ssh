-- Timestamps are UTC Unix epoch milliseconds. Revision starts at 1 and is incremented
-- by repositories for optimistic concurrency. Connections are soft-deleted first;
-- hard deletion cascades owned settings and recent-connection summaries.

CREATE TABLE connection_groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
    color TEXT CHECK (
        color IS NULL OR (
            length(color) = 7
            AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
        )
    ),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (is_collapsed IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    UNIQUE (name)
) STRICT;

CREATE TABLE key_references (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('file', 'imported')),
    file_path TEXT,
    encrypted_material BLOB,
    material_key_ref TEXT,
    passphrase_credential_ref TEXT CHECK (
        passphrase_credential_ref IS NULL OR length(trim(passphrase_credential_ref)) > 0
    ),
    public_key_algorithm TEXT CHECK (
        public_key_algorithm IS NULL OR length(trim(public_key_algorithm)) > 0
    ),
    fingerprint_sha256 TEXT CHECK (
        fingerprint_sha256 IS NULL OR (
            length(fingerprint_sha256) = 50
            AND substr(fingerprint_sha256, 1, 7) = 'SHA256:'
        )
    ),
    comment TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (
        (public_key_algorithm IS NULL AND fingerprint_sha256 IS NULL)
        OR (public_key_algorithm IS NOT NULL AND fingerprint_sha256 IS NOT NULL)
    ),
    CHECK (
        (
            storage_kind = 'file'
            AND file_path IS NOT NULL
            AND length(trim(file_path)) > 0
            AND encrypted_material IS NULL
            AND material_key_ref IS NULL
        )
        OR (
            storage_kind = 'imported'
            AND file_path IS NULL
            AND encrypted_material IS NOT NULL
            AND length(encrypted_material) > 0
            AND material_key_ref IS NOT NULL
            AND length(trim(material_key_ref)) > 0
        )
    )
) STRICT;

-- Credential references are opaque identifiers owned by the system credential store.
-- Imported key material is an encoded AES-GCM record and is never stored as plaintext.

CREATE TABLE connections (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT REFERENCES connection_groups (id) ON DELETE SET NULL,
    key_reference_id TEXT REFERENCES key_references (id) ON DELETE RESTRICT,
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
    host TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
    username TEXT NOT NULL CHECK (length(trim(username)) > 0),
    notes TEXT,
    color TEXT CHECK (
        color IS NULL OR (
            length(color) = 7
            AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
        )
    ),
    auth_method TEXT NOT NULL DEFAULT 'password' CHECK (
        auth_method IN ('password', 'private_key', 'keyboard_interactive')
    ),
    credential_ref TEXT CHECK (
        credential_ref IS NULL OR length(trim(credential_ref)) > 0
    ),
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= created_at),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (
        (auth_method = 'password' AND key_reference_id IS NULL)
        OR (
            auth_method = 'private_key'
            AND key_reference_id IS NOT NULL
            AND credential_ref IS NULL
        )
        OR (
            auth_method = 'keyboard_interactive'
            AND key_reference_id IS NULL
            AND credential_ref IS NULL
        )
    )
) STRICT;

CREATE TABLE settings (
    key TEXT NOT NULL CHECK (length(trim(key)) > 0),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    group_id TEXT REFERENCES connection_groups (id) ON DELETE CASCADE,
    connection_id TEXT REFERENCES connections (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (NOT (group_id IS NOT NULL AND connection_id IS NOT NULL))
) STRICT;

-- A setting with no owner is global. Exactly one owner selects a group or connection
-- override; the partial indexes below enforce one value per key at each scope.

CREATE TABLE host_fingerprints (
    id TEXT PRIMARY KEY NOT NULL,
    host TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
    key_algorithm TEXT NOT NULL CHECK (length(trim(key_algorithm)) > 0),
    fingerprint_sha256 TEXT NOT NULL CHECK (
        length(fingerprint_sha256) = 50
        AND substr(fingerprint_sha256, 1, 7) = 'SHA256:'
    ),
    first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
    trusted_at INTEGER NOT NULL CHECK (trusted_at >= first_seen_at),
    last_verified_at INTEGER NOT NULL CHECK (last_verified_at >= trusted_at),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    UNIQUE (host, port, key_algorithm)
) STRICT;

CREATE TABLE recent_connections (
    connection_id TEXT PRIMARY KEY NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    last_connected_at INTEGER NOT NULL CHECK (last_connected_at >= 0),
    successful_connection_count INTEGER NOT NULL DEFAULT 1 CHECK (
        successful_connection_count >= 1
    )
) STRICT;

CREATE UNIQUE INDEX settings_global_key_unique
    ON settings (key)
    WHERE group_id IS NULL AND connection_id IS NULL;

CREATE UNIQUE INDEX settings_group_key_unique
    ON settings (group_id, key)
    WHERE group_id IS NOT NULL AND connection_id IS NULL;

CREATE UNIQUE INDEX settings_connection_key_unique
    ON settings (connection_id, key)
    WHERE connection_id IS NOT NULL AND group_id IS NULL;

CREATE INDEX connection_groups_sort_index
    ON connection_groups (sort_order, name, id);

CREATE INDEX key_references_name_index
    ON key_references (name, id);

CREATE INDEX connections_group_sort_index
    ON connections (group_id, sort_order, name, id)
    WHERE deleted_at IS NULL;

CREATE INDEX connections_favorite_index
    ON connections (is_favorite DESC, name, id)
    WHERE deleted_at IS NULL;

CREATE INDEX connections_host_index
    ON connections (host, port)
    WHERE deleted_at IS NULL;

CREATE INDEX connections_key_reference_index
    ON connections (key_reference_id)
    WHERE key_reference_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX settings_group_index
    ON settings (group_id)
    WHERE group_id IS NOT NULL;

CREATE INDEX settings_connection_index
    ON settings (connection_id)
    WHERE connection_id IS NOT NULL;

CREATE INDEX host_fingerprints_verified_index
    ON host_fingerprints (last_verified_at DESC);

CREATE INDEX recent_connections_time_index
    ON recent_connections (last_connected_at DESC, connection_id);
