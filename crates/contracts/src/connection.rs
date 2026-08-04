use serde::{Deserialize, Serialize};
use specta::Type;

pub const DEFAULT_CONNECTION_PORT: u16 = 22;
pub const DEFAULT_CONNECT_TIMEOUT_SECS: u32 = 10;
pub const DEFAULT_KEEP_ALIVE_SECS: u32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    PrivateKey,
    KeyboardInteractive,
}

impl AuthMethod {
    pub const fn database_value(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKey => "private_key",
            Self::KeyboardInteractive => "keyboard_interactive",
        }
    }

    pub fn from_database_value(value: &str) -> Option<Self> {
        match value {
            "password" => Some(Self::Password),
            "private_key" => Some(Self::PrivateKey),
            "keyboard_interactive" => Some(Self::KeyboardInteractive),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub notes: Option<String>,
    pub color: Option<String>,
    pub auth_method: AuthMethod,
    pub credential_ref: Option<String>,
    pub key_reference_id: Option<String>,
}

impl ConnectionConfig {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        host: impl Into<String>,
        username: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            group_id: None,
            name: name.into(),
            host: host.into(),
            port: DEFAULT_CONNECTION_PORT,
            username: username.into(),
            notes: None,
            color: None,
            auth_method: AuthMethod::Password,
            credential_ref: None,
            key_reference_id: None,
        }
    }

    pub fn validate(&self) -> Result<(), ConnectionValidationError> {
        if self.id.trim().is_empty() {
            return Err(ConnectionValidationError::MissingId);
        }
        if self
            .group_id
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty())
        {
            return Err(ConnectionValidationError::InvalidGroupReference);
        }
        if self.name.trim().is_empty() {
            return Err(ConnectionValidationError::MissingName);
        }
        if self.host.trim().is_empty() {
            return Err(ConnectionValidationError::MissingHost);
        }
        if self.port == 0 {
            return Err(ConnectionValidationError::InvalidPort);
        }
        if self.username.trim().is_empty() {
            return Err(ConnectionValidationError::MissingUsername);
        }
        if self
            .color
            .as_deref()
            .is_some_and(|color| !is_hex_color(color))
        {
            return Err(ConnectionValidationError::InvalidColor);
        }
        if self
            .credential_ref
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty())
        {
            return Err(ConnectionValidationError::InvalidCredentialReference);
        }
        if self
            .key_reference_id
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty())
        {
            return Err(ConnectionValidationError::InvalidKeyReference);
        }

        match self.auth_method {
            AuthMethod::Password if self.key_reference_id.is_some() => {
                Err(ConnectionValidationError::ConflictingAuthenticationReferences)
            }
            AuthMethod::PrivateKey if self.key_reference_id.is_none() => {
                Err(ConnectionValidationError::MissingKeyReference)
            }
            AuthMethod::PrivateKey if self.credential_ref.is_some() => {
                Err(ConnectionValidationError::ConflictingAuthenticationReferences)
            }
            AuthMethod::KeyboardInteractive
                if self.credential_ref.is_some() || self.key_reference_id.is_some() =>
            {
                Err(ConnectionValidationError::ConflictingAuthenticationReferences)
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionValidationError {
    MissingId,
    InvalidGroupReference,
    MissingName,
    MissingHost,
    InvalidPort,
    MissingUsername,
    InvalidColor,
    InvalidCredentialReference,
    InvalidKeyReference,
    MissingKeyReference,
    ConflictingAuthenticationReferences,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettings {
    pub connect_timeout_secs: u32,
    pub keep_alive_secs: u32,
}

impl Default for ConnectionSettings {
    fn default() -> Self {
        Self {
            connect_timeout_secs: DEFAULT_CONNECT_TIMEOUT_SECS,
            keep_alive_secs: DEFAULT_KEEP_ALIVE_SECS,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettingsOverride {
    pub connect_timeout_secs: Option<u32>,
    pub keep_alive_secs: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettingsLayers {
    pub global: Option<ConnectionSettingsOverride>,
    pub group: Option<ConnectionSettingsOverride>,
    pub connection: Option<ConnectionSettingsOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionSettingsScope {
    Global,
    Group {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    Connection {
        #[serde(rename = "connectionId")]
        connection_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettingsSnapshot {
    pub layers: ConnectionSettingsLayers,
    pub resolved: ConnectionSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: u32,
    pub is_collapsed: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionListItem {
    pub config: ConnectionConfig,
    pub is_favorite: bool,
    pub sort_order: u32,
    pub last_connected_at: Option<u64>,
    pub successful_connection_count: u64,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCatalog {
    pub groups: Vec<ConnectionGroup>,
    pub connections: Vec<ConnectionListItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDetails {
    pub connection: ConnectionListItem,
    pub settings: ConnectionSettingsSnapshot,
}

impl ConnectionSettingsLayers {
    pub fn resolve(&self) -> ConnectionSettings {
        let mut resolved = ConnectionSettings::default();
        for layer in [self.global, self.group, self.connection]
            .into_iter()
            .flatten()
        {
            if let Some(value) = layer.connect_timeout_secs {
                resolved.connect_timeout_secs = value;
            }
            if let Some(value) = layer.keep_alive_secs {
                resolved.keep_alive_secs = value;
            }
        }
        resolved
    }
}

fn is_hex_color(color: &str) -> bool {
    let bytes = color.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(byte) || (b'A'..=b'F').contains(byte)
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn creates_a_connection_with_product_defaults() {
        let connection =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");

        assert_eq!(connection.port, DEFAULT_CONNECTION_PORT);
        assert_eq!(connection.auth_method, AuthMethod::Password);
        assert_eq!(connection.credential_ref, None);
        assert_eq!(connection.key_reference_id, None);
        assert!(connection.validate().is_ok());
        assert_eq!(
            ConnectionSettingsLayers::default().resolve(),
            ConnectionSettings {
                connect_timeout_secs: DEFAULT_CONNECT_TIMEOUT_SECS,
                keep_alive_secs: DEFAULT_KEEP_ALIVE_SECS,
            }
        );
    }

    #[test]
    fn validates_authentication_reference_rules() {
        let mut connection =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        connection.key_reference_id = Some("key-1".to_owned());
        assert_eq!(
            connection.validate(),
            Err(ConnectionValidationError::ConflictingAuthenticationReferences)
        );

        connection.auth_method = AuthMethod::PrivateKey;
        connection.credential_ref = Some("credential-1".to_owned());
        assert_eq!(
            connection.validate(),
            Err(ConnectionValidationError::ConflictingAuthenticationReferences)
        );

        connection.credential_ref = None;
        assert!(connection.validate().is_ok());

        connection.auth_method = AuthMethod::KeyboardInteractive;
        connection.key_reference_id = None;
        assert!(connection.validate().is_ok());
    }

    #[test]
    fn validates_required_fields_port_and_color() {
        let mut connection =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        connection.port = 0;
        assert_eq!(
            connection.validate(),
            Err(ConnectionValidationError::InvalidPort)
        );

        connection.port = DEFAULT_CONNECTION_PORT;
        connection.color = Some("#12FG00".to_owned());
        assert_eq!(
            connection.validate(),
            Err(ConnectionValidationError::InvalidColor)
        );

        connection.color = Some("#12fA00".to_owned());
        connection.group_id = Some("  ".to_owned());
        assert_eq!(
            connection.validate(),
            Err(ConnectionValidationError::InvalidGroupReference)
        );

        connection.group_id = None;
        connection.name = "  ".to_owned();
        assert_eq!(
            connection.validate(),
            Err(ConnectionValidationError::MissingName)
        );
    }

    #[test]
    fn resolves_settings_in_global_group_connection_order() {
        let layers = ConnectionSettingsLayers {
            global: Some(ConnectionSettingsOverride {
                connect_timeout_secs: Some(20),
                keep_alive_secs: Some(45),
            }),
            group: Some(ConnectionSettingsOverride {
                connect_timeout_secs: None,
                keep_alive_secs: Some(60),
            }),
            connection: Some(ConnectionSettingsOverride {
                connect_timeout_secs: Some(5),
                keep_alive_secs: None,
            }),
        };

        assert_eq!(
            layers.resolve(),
            ConnectionSettings {
                connect_timeout_secs: 5,
                keep_alive_secs: 60,
            }
        );
    }

    #[test]
    fn keeps_database_auth_values_stable_and_serializes_contract_fields_in_camel_case() {
        assert_eq!(AuthMethod::PrivateKey.database_value(), "private_key");
        assert_eq!(
            AuthMethod::from_database_value("keyboard_interactive"),
            Some(AuthMethod::KeyboardInteractive)
        );
        assert_eq!(AuthMethod::from_database_value("unknown"), None);

        let connection =
            ConnectionConfig::new("connection-1", "Production", "example.com", "alice");
        let value = serde_json::to_value(connection).unwrap();
        assert_eq!(value["authMethod"], json!("password"));
        assert_eq!(value["keyReferenceId"], json!(null));
        assert_eq!(value["credentialRef"], json!(null));

        let scope = serde_json::to_value(ConnectionSettingsScope::Group {
            group_id: "group-1".to_owned(),
        })
        .unwrap();
        assert_eq!(scope, json!({ "kind": "group", "groupId": "group-1" }));
    }
}
