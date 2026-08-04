use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};

use bx_contracts::{
    AuthMethod, ConnectionCatalog, ConnectionConfig, ConnectionListItem, OpenSshDuplicateStrategy,
    OpenSshImportError, OpenSshImportItem, OpenSshImportPreview, OpenSshImportRequest,
    OpenSshImportResult, OpenSshImportWarning, DEFAULT_CONNECTION_PORT,
};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::command_error::{CommandError, CommandErrorCode};
use crate::connections::{
    app_data_directory, current_timestamp_ms, run_query, ConnectionRepositoryState,
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub(crate) async fn preview_openssh_config(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    path: Option<String>,
) -> Result<OpenSshImportPreview, CommandError> {
    let path = resolve_config_path(path)?;
    let source = read_config(&path).await?;
    let data_directory = app_data_directory(&app)?;
    let catalog = run_query(state.inner().clone(), data_directory, |repository| {
        repository.list_catalog()
    })
    .await?;
    Ok(build_preview(
        &path,
        &source,
        &catalog,
        default_username().as_deref(),
        home_directory().as_deref(),
    ))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn import_openssh_connections(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    request: OpenSshImportRequest,
) -> Result<OpenSshImportResult, CommandError> {
    validate_selection(&request.selected_source_ids)?;
    let path = resolve_config_path(Some(request.source_path))?;
    let source = read_config(&path).await?;
    if request.source_fingerprint != source_fingerprint(&source) {
        return Err(CommandError::new(
            CommandErrorCode::OpenSshConfigInvalid,
            "OpenSSH config changed after preview",
        ));
    }
    let data_directory = app_data_directory(&app)?;
    let catalog = run_query(
        state.inner().clone(),
        data_directory.clone(),
        |repository| repository.list_catalog(),
    )
    .await?;
    let preview = build_preview(
        &path,
        &source,
        &catalog,
        default_username().as_deref(),
        home_directory().as_deref(),
    );
    let selected: HashSet<_> = request.selected_source_ids.into_iter().collect();
    let preview_ids: HashSet<_> = preview
        .items
        .iter()
        .map(|item| item.source_id.as_str())
        .collect();
    if selected.iter().any(|id| !preview_ids.contains(id.as_str())) {
        return Err(CommandError::new(
            CommandErrorCode::OpenSshConfigInvalid,
            "OpenSSH config changed after preview",
        ));
    }

    let connections_by_id: HashMap<_, _> = catalog
        .connections
        .iter()
        .map(|item| (item.config.id.as_str(), item))
        .collect();
    let mut configs = Vec::new();
    let mut result = OpenSshImportResult {
        imported: 0,
        overwritten: 0,
        skipped: 0,
    };

    for item in preview
        .items
        .iter()
        .filter(|item| selected.contains(&item.source_id))
    {
        if !item.is_importable() {
            result.skipped += 1;
            continue;
        }
        if let Some(duplicate_id) = item.duplicate_connection_id.as_deref() {
            if request.duplicate_strategy == OpenSshDuplicateStrategy::Skip {
                result.skipped += 1;
                continue;
            }
            let Some(existing) = connections_by_id.get(duplicate_id) else {
                return Err(CommandError::new(
                    CommandErrorCode::OpenSshConfigInvalid,
                    "duplicate connection changed after preview",
                ));
            };
            configs.push(overwrite_config(&existing.config, item));
            result.overwritten += 1;
        } else {
            configs.push(new_config(item));
            result.imported += 1;
        }
    }

    if !configs.is_empty() {
        let now_ms = current_timestamp_ms()?;
        run_query(state.inner().clone(), data_directory, move |repository| {
            repository.import_connections(&configs, now_ms)
        })
        .await?;
    }
    Ok(result)
}

async fn read_config(path: &Path) -> Result<String, CommandError> {
    let metadata = tokio::fs::metadata(path).await.map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            CommandErrorCode::OpenSshConfigNotFound
        } else {
            CommandErrorCode::OpenSshConfigIoError
        };
        CommandError::new(code, "OpenSSH config could not be read")
    })?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return Err(CommandError::new(
            CommandErrorCode::OpenSshConfigInvalid,
            "OpenSSH config must be a text file no larger than 1 MiB",
        ));
    }
    tokio::fs::read_to_string(path).await.map_err(|_| {
        CommandError::new(
            CommandErrorCode::OpenSshConfigIoError,
            "OpenSSH config must contain valid UTF-8 text",
        )
    })
}

fn resolve_config_path(path: Option<String>) -> Result<PathBuf, CommandError> {
    match path.map(|value| value.trim().to_owned()) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => default_config_path(),
    }
}

fn default_config_path() -> Result<PathBuf, CommandError> {
    home_directory()
        .map(|home| home.join(".ssh").join("config"))
        .ok_or_else(|| {
            CommandError::new(
                CommandErrorCode::OpenSshConfigNotFound,
                "user home directory is unavailable",
            )
        })
}

fn home_directory() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn default_username() -> Option<String> {
    env::var("USERNAME")
        .or_else(|_| env::var("USER"))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn validate_selection(ids: &[String]) -> Result<(), CommandError> {
    if ids.is_empty()
        || ids.iter().any(|id| id.trim().is_empty())
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(CommandError::new(
            CommandErrorCode::OpenSshConfigInvalid,
            "OpenSSH import selection is invalid",
        ));
    }
    Ok(())
}

fn build_preview(
    path: &Path,
    source: &str,
    catalog: &ConnectionCatalog,
    default_username: Option<&str>,
    home: Option<&Path>,
) -> OpenSshImportPreview {
    let parsed = parse_config(source);
    let mut items = Vec::new();
    let mut ignored_host_patterns = 0;
    for stanza in parsed.stanzas {
        for alias in stanza.aliases {
            if is_host_pattern(&alias.value) {
                ignored_host_patterns += 1;
                continue;
            }
            let host = stanza
                .host_name
                .as_deref()
                .or(parsed.defaults.host_name.as_deref())
                .unwrap_or(&alias.value)
                .trim()
                .to_owned();
            let username = stanza
                .user
                .as_deref()
                .or(parsed.defaults.user.as_deref())
                .or(default_username)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let port_value = stanza.port.as_deref().or(parsed.defaults.port.as_deref());
            let (port, invalid_port) = parse_port(port_value);
            let identity_file = stanza
                .identity_file
                .as_deref()
                .or(parsed.defaults.identity_file.as_deref())
                .map(|value| expand_home(value, home));
            let mut errors = Vec::new();
            if host.is_empty() {
                errors.push(OpenSshImportError::MissingHost);
            }
            if username.is_empty() {
                errors.push(OpenSshImportError::MissingUsername);
            }
            if invalid_port {
                errors.push(OpenSshImportError::InvalidPort);
            }
            let duplicate = find_duplicate(catalog, &alias.value, &host, port, &username);
            let mut warnings = Vec::new();
            if duplicate.is_some() {
                warnings.push(OpenSshImportWarning::Duplicate);
            }
            if identity_file.is_some() {
                warnings.push(OpenSshImportWarning::IdentityFileRequiresKeySetup);
            }
            items.push(OpenSshImportItem {
                source_id: format!("{}:{}", alias.line, alias.value),
                alias: alias.value,
                host,
                port,
                username,
                identity_file,
                duplicate_connection_id: duplicate.map(|item| item.config.id.clone()),
                duplicate_connection_name: duplicate.map(|item| item.config.name.clone()),
                errors,
                warnings,
            });
        }
    }
    OpenSshImportPreview {
        source_path: path.to_string_lossy().into_owned(),
        source_fingerprint: source_fingerprint(source),
        items,
        ignored_host_patterns,
    }
}

fn source_fingerprint(source: &str) -> String {
    Sha256::digest(source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn find_duplicate<'a>(
    catalog: &'a ConnectionCatalog,
    alias: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Option<&'a ConnectionListItem> {
    catalog
        .connections
        .iter()
        .find(|item| item.config.name.eq_ignore_ascii_case(alias))
        .or_else(|| {
            catalog.connections.iter().find(|item| {
                item.config.host.eq_ignore_ascii_case(host)
                    && item.config.port == port
                    && item.config.username.eq_ignore_ascii_case(username)
            })
        })
}

fn new_config(item: &OpenSshImportItem) -> ConnectionConfig {
    let mut config = ConnectionConfig::new(
        format!("connection-{}", Uuid::new_v4()),
        &item.alias,
        &item.host,
        &item.username,
    );
    config.port = item.port;
    config.notes = identity_note(item.identity_file.as_deref());
    config.auth_method = AuthMethod::Password;
    config
}

fn overwrite_config(existing: &ConnectionConfig, item: &OpenSshImportItem) -> ConnectionConfig {
    let mut config = existing.clone();
    config.name.clone_from(&item.alias);
    config.host.clone_from(&item.host);
    config.port = item.port;
    config.username.clone_from(&item.username);
    if item.identity_file.is_some() {
        config.notes = identity_note(item.identity_file.as_deref());
    }
    config
}

fn identity_note(path: Option<&str>) -> Option<String> {
    path.map(|value| format!("OpenSSH IdentityFile: {value}"))
}

#[derive(Default)]
struct ParsedConfig {
    defaults: RawOptions,
    stanzas: Vec<RawStanza>,
}

#[derive(Default)]
struct RawOptions {
    host_name: Option<String>,
    port: Option<String>,
    user: Option<String>,
    identity_file: Option<String>,
}

struct RawStanza {
    aliases: Vec<RawAlias>,
    host_name: Option<String>,
    port: Option<String>,
    user: Option<String>,
    identity_file: Option<String>,
}

struct RawAlias {
    line: usize,
    value: String,
}

fn parse_config(source: &str) -> ParsedConfig {
    let mut parsed = ParsedConfig::default();
    let mut current: Option<RawStanza> = None;
    for (index, raw_line) in source.lines().enumerate() {
        let Some((key, value)) = split_directive(raw_line) else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            if let Some(stanza) = current.take() {
                parsed.stanzas.push(stanza);
            }
            current = Some(RawStanza {
                aliases: split_words(&value)
                    .into_iter()
                    .map(|value| RawAlias {
                        line: index + 1,
                        value,
                    })
                    .collect(),
                host_name: None,
                port: None,
                user: None,
                identity_file: None,
            });
            continue;
        }
        let options = current
            .as_mut()
            .map(|stanza| RawOptionsRef {
                host_name: &mut stanza.host_name,
                port: &mut stanza.port,
                user: &mut stanza.user,
                identity_file: &mut stanza.identity_file,
            })
            .unwrap_or_else(|| RawOptionsRef {
                host_name: &mut parsed.defaults.host_name,
                port: &mut parsed.defaults.port,
                user: &mut parsed.defaults.user,
                identity_file: &mut parsed.defaults.identity_file,
            });
        options.set(&key, unquote(value.trim()));
    }
    if let Some(stanza) = current {
        parsed.stanzas.push(stanza);
    }
    parsed
}

struct RawOptionsRef<'a> {
    host_name: &'a mut Option<String>,
    port: &'a mut Option<String>,
    user: &'a mut Option<String>,
    identity_file: &'a mut Option<String>,
}

impl RawOptionsRef<'_> {
    fn set(self, key: &str, value: String) {
        let target = if key.eq_ignore_ascii_case("hostname") {
            Some(self.host_name)
        } else if key.eq_ignore_ascii_case("port") {
            Some(self.port)
        } else if key.eq_ignore_ascii_case("user") {
            Some(self.user)
        } else if key.eq_ignore_ascii_case("identityfile") {
            Some(self.identity_file)
        } else {
            None
        };
        if let Some(target) = target {
            if target.is_none() {
                *target = Some(value);
            }
        }
    }
}

fn split_directive(line: &str) -> Option<(String, String)> {
    let line = strip_comment(line).trim().trim_start_matches('\u{feff}');
    if line.is_empty() {
        return None;
    }
    let key_end = line
        .char_indices()
        .find_map(|(index, character)| {
            (character.is_whitespace() || character == '=').then_some(index)
        })
        .unwrap_or(line.len());
    let key = line[..key_end].trim();
    let value = line[key_end..]
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(&line[key_end..])
        .trim();
    (!key.is_empty() && !value.is_empty()).then(|| (key.to_owned(), value.to_owned()))
}

fn strip_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            continue;
        }
        if character == '#' && quote.is_none() {
            return &line[..index];
        }
    }
    line
}

fn split_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_owned();
        }
    }
    value.to_owned()
}

fn parse_port(value: Option<&str>) -> (u16, bool) {
    match value {
        None => (DEFAULT_CONNECTION_PORT, false),
        Some(value) => match value.parse::<u16>() {
            Ok(0) | Err(_) => (DEFAULT_CONNECTION_PORT, true),
            Ok(port) => (port, false),
        },
    }
}

fn is_host_pattern(alias: &str) -> bool {
    alias.starts_with('!')
        || alias
            .chars()
            .any(|character| matches!(character, '*' | '?'))
}

fn expand_home(value: &str, home: Option<&Path>) -> String {
    let trimmed = value.trim();
    if let (Some(home), Some(relative)) = (
        home,
        trimmed
            .strip_prefix("~/")
            .or_else(|| trimmed.strip_prefix("~\\")),
    ) {
        return home.join(relative).to_string_lossy().into_owned();
    }
    trimmed.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_catalog() -> ConnectionCatalog {
        ConnectionCatalog {
            groups: Vec::new(),
            connections: Vec::new(),
        }
    }

    #[test]
    fn parses_basic_hosts_defaults_comments_and_identity_files() {
        let source = r#"
            User deploy
            Port 2222
            Host production prod
              HostName server.example.com # reviewed endpoint
              IdentityFile "~/.ssh/id_ed25519"

            Host *.internal !blocked
              User ignored
        "#;
        let preview = build_preview(
            Path::new("C:/Users/alice/.ssh/config"),
            source,
            &empty_catalog(),
            Some("alice"),
            Some(Path::new("C:/Users/alice")),
        );

        assert_eq!(preview.items.len(), 2);
        assert_eq!(preview.ignored_host_patterns, 2);
        assert_eq!(preview.items[0].alias, "production");
        assert_eq!(preview.items[0].host, "server.example.com");
        assert_eq!(preview.items[0].port, 2222);
        assert_eq!(preview.items[0].username, "deploy");
        assert_eq!(
            preview.items[0]
                .identity_file
                .as_deref()
                .map(|value| value.replace('\\', "/")),
            Some("C:/Users/alice/.ssh/id_ed25519".to_owned())
        );
        assert_eq!(
            preview.items[0].warnings,
            vec![OpenSshImportWarning::IdentityFileRequiresKeySetup]
        );
    }

    #[test]
    fn reports_invalid_ports_and_uses_the_local_username_default() {
        let preview = build_preview(
            Path::new("config"),
            "Host test\nHostName 10.0.0.1\nPort 70000\n",
            &empty_catalog(),
            Some("local-user"),
            None,
        );

        assert_eq!(preview.items[0].username, "local-user");
        assert_eq!(preview.items[0].port, 22);
        assert_eq!(
            preview.items[0].errors,
            vec![OpenSshImportError::InvalidPort]
        );
    }

    #[test]
    fn detects_duplicates_by_name_or_endpoint() {
        let mut existing =
            ConnectionConfig::new("connection-1", "production", "server.example.com", "deploy");
        existing.port = 2222;
        let catalog = ConnectionCatalog {
            groups: Vec::new(),
            connections: vec![ConnectionListItem {
                config: existing,
                is_favorite: false,
                sort_order: 0,
                last_connected_at: None,
                successful_connection_count: 0,
                revision: 1,
            }],
        };
        let preview = build_preview(
            Path::new("config"),
            "Host production\nHostName other.example.com\nUser root\n",
            &catalog,
            None,
            None,
        );

        assert_eq!(
            preview.items[0].duplicate_connection_id.as_deref(),
            Some("connection-1")
        );
        assert_eq!(
            preview.items[0].warnings,
            vec![OpenSshImportWarning::Duplicate]
        );
    }

    #[test]
    fn rejects_empty_or_duplicate_import_selections() {
        assert!(validate_selection(&[]).is_err());
        assert!(validate_selection(&["a".to_owned(), "a".to_owned()]).is_err());
        assert!(validate_selection(&["a".to_owned()]).is_ok());
    }
}
