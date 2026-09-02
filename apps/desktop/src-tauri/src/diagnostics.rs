use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tauri::AppHandle;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::command_error::{CommandError, CommandErrorCode};
use crate::connections::app_data_directory;

const LOG_DIRECTORY_NAME: &str = "logs";
const LOG_FILE_NAME: &str = "bx-ssh.jsonl";
const DIAGNOSTICS_MANIFEST_NAME: &str = "manifest.json";
const MAX_LOG_LINE_BYTES: usize = 256 * 1024;
const MAX_LOG_FILES: usize = 16;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsManifest {
    schema_version: u32,
    app_version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    generated_at_ms: u64,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn open_log_directory(app: AppHandle) -> Result<(), CommandError> {
    let directory = log_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| {
        CommandError::new(
            CommandErrorCode::LogDirectoryUnavailable,
            format!("unable to create the log directory: {error}"),
        )
    })?;
    open::that_detached(&directory).map_err(|_| {
        CommandError::new(
            CommandErrorCode::LogDirectoryUnavailable,
            "unable to open the log directory",
        )
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn export_diagnostics(app: AppHandle, destination: String) -> Result<(), CommandError> {
    let destination = validate_destination(&destination)?;
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(export_error)?;
    let temporary = parent.join(format!(".bx-ssh-diagnostics-{}.tmp", Uuid::new_v4()));

    let logs = log_directory(&app)?;
    let result = write_diagnostics(&logs, &temporary)
        .and_then(|()| fs::rename(&temporary, &destination).map_err(export_error));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_diagnostics(logs: &Path, destination: &Path) -> Result<(), CommandError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(export_error)?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o600);
    let manifest = DiagnosticsManifest {
        schema_version: 1,
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        generated_at_ms: current_timestamp_ms(),
    };
    let manifest = serde_json::to_vec_pretty(&manifest).map_err(export_error)?;
    archive
        .start_file(DIAGNOSTICS_MANIFEST_NAME, options)
        .map_err(export_error)?;
    archive.write_all(&manifest).map_err(export_error)?;

    for (index, path) in log_files(logs).into_iter().enumerate() {
        let archive_name = format!(
            "logs/{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        let sanitized = sanitize_log_file(&path)?;
        archive
            .start_file(archive_name, options)
            .map_err(export_error)?;
        archive.write_all(&sanitized).map_err(export_error)?;
        if index + 1 >= MAX_LOG_FILES {
            break;
        }
    }
    archive.finish().map_err(export_error)?;
    Ok(())
}

fn log_directory(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(app_data_directory(app)?.join(LOG_DIRECTORY_NAME))
}

fn log_files(directory: &Path) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(LOG_FILE_NAME))
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn sanitize_log_file(path: &Path) -> Result<Vec<u8>, CommandError> {
    let file = File::open(path).map_err(export_error)?;
    let mut output = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(export_error)?;
        if line.len() > MAX_LOG_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };
        let sanitized = allowlisted_log_entry(object);
        serde_json::to_writer(&mut output, &sanitized).map_err(export_error)?;
        output.push(b'\n');
    }
    Ok(output)
}

fn allowlisted_log_entry(object: &Map<String, Value>) -> Map<String, Value> {
    const ALLOWED_FIELDS: [&str; 9] = [
        "timestampMs",
        "level",
        "event",
        "sessionType",
        "attemptId",
        "sessionId",
        "transferId",
        "connectionStage",
        "errorCode",
    ];
    ALLOWED_FIELDS
        .into_iter()
        .filter_map(|field| {
            object
                .get(field)
                .and_then(|value| sanitize_field(field, value))
        })
        .collect()
}

fn sanitize_field(field: &str, value: &Value) -> Option<(String, Value)> {
    let value = match field {
        "timestampMs" if value.as_u64().is_some() => value.clone(),
        "level" if matches!(value.as_str(), Some("error" | "warn" | "info" | "debug")) => {
            value.clone()
        }
        "sessionType" if matches!(value.as_str(), Some("terminal" | "sftp")) => value.clone(),
        "connectionStage"
            if value.as_str().is_some_and(|value| {
                matches!(
                    value,
                    "created"
                        | "resolvingDns"
                        | "connectingTcp"
                        | "handshaking"
                        | "authenticating"
                        | "openingChannel"
                        | "connected"
                        | "closing"
                        | "closed"
                        | "cancelled"
                        | "failed"
                )
            }) =>
        {
            value.clone()
        }
        "event" if value.as_str().is_some_and(is_known_event) => value.clone(),
        "errorCode" if value.as_str().is_some_and(is_safe_token) => value.clone(),
        "attemptId" | "sessionId" | "transferId"
            if value
                .as_str()
                .is_some_and(|value| Uuid::parse_str(value).is_ok()) =>
        {
            value.clone()
        }
        _ => return None,
    };
    Some((field.to_owned(), value))
}

fn is_known_event(value: &str) -> bool {
    matches!(
        value,
        "application_started"
            | "ssh_connection_stage_changed"
            | "ssh_connection_failed"
            | "ssh_session_closed"
            | "sftp_transfer_failed"
            | "update_failed"
    )
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn validate_destination(value: &str) -> Result<PathBuf, CommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(CommandError::new(
            CommandErrorCode::DiagnosticsExportFailed,
            "diagnostic package destination is invalid",
        ));
    }
    let path = PathBuf::from(trimmed);
    if path.file_name().is_none() || path.is_dir() {
        return Err(CommandError::new(
            CommandErrorCode::DiagnosticsExportFailed,
            "diagnostic package destination is invalid",
        ));
    }
    Ok(path)
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

fn export_error(error: impl Into<io::Error>) -> CommandError {
    let error: io::Error = error.into();
    CommandError::new(
        CommandErrorCode::DiagnosticsExportFailed,
        format!("diagnostic package operation failed: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};

    use super::{
        allowlisted_log_entry, sanitize_log_file, validate_destination, write_diagnostics,
    };
    use serde_json::json;
    use uuid::Uuid;
    use zip::ZipArchive;

    #[test]
    fn strips_hosts_users_paths_and_unknown_log_fields() {
        let input = json!({
            "timestampMs": 1,
            "level": "error",
            "event": "ssh_connection_failed",
            "sessionType": "terminal",
            "errorCode": "authentication_rejected",
            "host": "server.example.com",
            "username": "alice",
            "path": "C:/Users/alice/secret",
            "message": "password=secret"
        });
        let output = allowlisted_log_entry(input.as_object().unwrap());
        assert_eq!(
            output.get("event").and_then(|value| value.as_str()),
            Some("ssh_connection_failed")
        );
        assert!(!output.contains_key("host"));
        assert!(!output.contains_key("username"));
        assert!(!output.contains_key("path"));
        assert!(!output.contains_key("message"));
    }

    #[test]
    fn rejects_empty_or_nul_destinations() {
        assert!(validate_destination("").is_err());
        assert!(validate_destination("bad\0.zip").is_err());
        assert!(validate_destination("diagnostics.zip").is_ok());
    }

    #[test]
    fn sanitizes_existing_log_lines_before_packaging() {
        let directory = std::env::temp_dir().join(format!("bx-ssh-diagnostics-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("bx-ssh.jsonl");
        fs::write(
            &path,
            "{\"timestampMs\":1,\"event\":\"application_started\",\"host\":\"server.example.com\",\"message\":\"password=secret\"}\nnot-json\n",
        )
        .unwrap();

        let output = String::from_utf8(sanitize_log_file(&path).unwrap()).unwrap();
        assert!(output.contains("\"event\":\"application_started\""));
        assert!(!output.contains("server.example.com"));
        assert!(!output.contains("password=secret"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn writes_a_zip_with_a_manifest_and_sanitized_logs() {
        let directory = std::env::temp_dir().join(format!("bx-ssh-diagnostics-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let logs = directory.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            logs.join("bx-ssh.jsonl"),
            "{\"timestampMs\":1,\"level\":\"info\",\"event\":\"application_started\",\"path\":\"secret\"}\n",
        )
        .unwrap();
        let archive_path = directory.join("diagnostics.zip");
        write_diagnostics(&logs, &archive_path).unwrap();

        let archive_file = File::open(&archive_path).unwrap();
        let mut archive = ZipArchive::new(archive_file).unwrap();
        let mut manifest = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("manifest.json").unwrap(),
            &mut manifest,
        )
        .unwrap();
        let mut log = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("logs/bx-ssh.jsonl").unwrap(), &mut log)
            .unwrap();
        assert!(manifest.contains("\"schemaVersion\": 1"));
        assert!(log.contains("\"event\":\"application_started\""));
        assert!(!log.contains("secret"));
        fs::remove_dir_all(directory).unwrap();
    }
}
