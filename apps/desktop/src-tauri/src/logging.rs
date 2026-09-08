use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use bx_contracts::{LogLevel, SshConnectionStage};
use serde::Serialize;

use crate::command_error::{CommandError, CommandErrorCode};
use crate::session_manager::SessionKind;
use bx_ssh_core::SshError;

const LOG_FILE_NAME: &str = "bx-ssh.jsonl";
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_BACKUPS: usize = 5;
const MILLIS_PER_DAY: u64 = 24 * 60 * 60 * 1_000;

static LOGGER: OnceLock<AppLogger> = OnceLock::new();

/// Only stable identifiers and enums are accepted here; free-form payloads are intentionally
/// unavailable so credentials, terminal input, paths, and protocol messages cannot be logged.
#[derive(Clone, Copy, Default)]
pub(crate) struct LogFields<'a> {
    pub(crate) session_type: Option<&'a str>,
    pub(crate) attempt_id: Option<&'a str>,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) transfer_id: Option<&'a str>,
    pub(crate) connection_stage: Option<SshConnectionStage>,
    pub(crate) error_code: Option<CommandErrorCode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry<'a> {
    timestamp_ms: u64,
    level: LogLevel,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transfer_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_stage: Option<SshConnectionStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<CommandErrorCode>,
}

struct AppLogger {
    level: AtomicU8,
    writer: Mutex<RollingLogWriter>,
}

struct RollingLogWriter {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    day: u64,
    max_file_bytes: u64,
    max_backups: usize,
}

pub(crate) fn initialize(log_directory: PathBuf, level: LogLevel) -> io::Result<()> {
    if let Some(logger) = LOGGER.get() {
        logger.set_level(level);
        return Ok(());
    }

    let logger = AppLogger::new(
        log_directory.join(LOG_FILE_NAME),
        level,
        MAX_LOG_FILE_BYTES,
        MAX_LOG_BACKUPS,
    )?;
    let _ = LOGGER.set(logger);
    set_level(level);
    Ok(())
}

pub(crate) fn set_level(level: LogLevel) {
    if let Some(logger) = LOGGER.get() {
        logger.set_level(level);
    }
}

pub(crate) fn event(level: LogLevel, event: &'static str, fields: LogFields<'_>) {
    if let Some(logger) = LOGGER.get() {
        logger.log(level, event, fields);
    }
}

pub(crate) fn connection_error(kind: SessionKind, attempt_id: &str, error: &CommandError) {
    event(
        LogLevel::Error,
        "ssh_connection_failed",
        LogFields {
            session_type: Some(kind.as_str()),
            attempt_id: Some(attempt_id),
            connection_stage: error.stage,
            error_code: Some(error.code),
            ..LogFields::default()
        },
    );
}

pub(crate) fn connection_ssh_error(
    kind: SessionKind,
    attempt_id: &str,
    error: &SshError,
    fallback_stage: SshConnectionStage,
) {
    let mut command_error = CommandError::from_ssh(error);
    if command_error.stage.is_none() {
        command_error.stage = Some(fallback_stage);
    }
    connection_error(kind, attempt_id, &command_error);
}

pub(crate) fn command_error(event_name: &'static str, error: &CommandError, fields: LogFields<'_>) {
    event(
        LogLevel::Error,
        event_name,
        LogFields {
            connection_stage: fields.connection_stage.or(error.stage),
            error_code: Some(error.code),
            ..fields
        },
    );
}

impl AppLogger {
    fn new(
        path: PathBuf,
        level: LogLevel,
        max_file_bytes: u64,
        max_backups: usize,
    ) -> io::Result<Self> {
        Ok(Self {
            level: AtomicU8::new(level_value(level)),
            writer: Mutex::new(RollingLogWriter::new(path, max_file_bytes, max_backups)?),
        })
    }

    fn set_level(&self, level: LogLevel) {
        self.level.store(level_value(level), Ordering::Relaxed);
    }

    fn log(&self, level: LogLevel, event: &'static str, fields: LogFields<'_>) {
        self.log_at(current_timestamp_ms(), level, event, fields);
    }

    fn log_at(
        &self,
        timestamp_ms: u64,
        level: LogLevel,
        event: &'static str,
        fields: LogFields<'_>,
    ) {
        if level_value(level) > self.level.load(Ordering::Relaxed) {
            return;
        }

        let entry = LogEntry {
            timestamp_ms,
            level,
            event,
            session_type: fields.session_type,
            attempt_id: fields.attempt_id,
            session_id: fields.session_id,
            transfer_id: fields.transfer_id,
            connection_stage: fields.connection_stage,
            error_code: fields.error_code,
        };
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write(&entry);
        }
    }
}

impl RollingLogWriter {
    fn new(path: PathBuf, max_file_bytes: u64, max_backups: usize) -> io::Result<Self> {
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory)?;
        }
        let file = open_log_file(&path)?;
        let metadata = file.metadata()?;
        let day = metadata
            .modified()
            .ok()
            .and_then(system_time_ms)
            .unwrap_or_else(current_timestamp_ms)
            / MILLIS_PER_DAY;
        Ok(Self {
            path,
            file: Some(file),
            size: metadata.len(),
            day,
            max_file_bytes,
            max_backups,
        })
    }

    fn write(&mut self, entry: &LogEntry<'_>) -> io::Result<()> {
        let mut encoded = serde_json::to_vec(entry).map_err(io::Error::other)?;
        encoded.push(b'\n');
        let entry_day = entry.timestamp_ms / MILLIS_PER_DAY;
        let exceeds_size = self.size > 0
            && self
                .size
                .saturating_add(u64::try_from(encoded.len()).unwrap_or(u64::MAX))
                > self.max_file_bytes;
        if self.size > 0 && (entry_day != self.day || exceeds_size) {
            self.rotate(entry_day)?;
        }

        let file = self.file.as_mut().expect("log file must be open");
        file.write_all(&encoded)?;
        file.flush()?;
        self.size = self
            .size
            .saturating_add(u64::try_from(encoded.len()).unwrap_or(u64::MAX));
        self.day = entry_day;
        Ok(())
    }

    fn rotate(&mut self, day: u64) -> io::Result<()> {
        if let Some(file) = self.file.take() {
            file.sync_all()?;
        }

        if self.max_backups > 0 {
            let oldest = backup_path(&self.path, self.max_backups);
            remove_file_if_exists(&oldest)?;
            for index in (1..self.max_backups).rev() {
                let source = backup_path(&self.path, index);
                let target = backup_path(&self.path, index + 1);
                rename_if_exists(&source, &target)?;
            }
            rename_if_exists(&self.path, &backup_path(&self.path, 1))?;
        } else {
            remove_file_if_exists(&self.path)?;
        }

        self.file = Some(open_log_file(&self.path)?);
        self.size = 0;
        self.day = day;
        Ok(())
    }
}

fn level_value(level: LogLevel) -> u8 {
    match level {
        LogLevel::Error => 1,
        LogLevel::Warn => 2,
        LogLevel::Info => 3,
        LogLevel::Debug => 4,
    }
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

fn system_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
}

fn open_log_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

fn remove_file_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn rename_if_exists(source: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use uuid::Uuid;

    fn test_directory() -> PathBuf {
        std::env::temp_dir().join(format!("bx-ssh-logging-{}", Uuid::new_v4()))
    }

    fn read_entries(path: &Path) -> Vec<Value> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn writes_structured_whitelisted_fields_without_sensitive_content() {
        let directory = test_directory();
        let path = directory.join(LOG_FILE_NAME);
        let logger = AppLogger::new(path.clone(), LogLevel::Debug, 4096, 2).unwrap();
        logger.log_at(
            1_700_000_000_000,
            LogLevel::Error,
            "ssh_connection_failed",
            LogFields {
                session_type: Some("terminal"),
                attempt_id: Some("attempt-1"),
                connection_stage: Some(SshConnectionStage::Authenticating),
                error_code: Some(CommandErrorCode::AuthenticationRejected),
                ..LogFields::default()
            },
        );

        let raw = fs::read_to_string(&path).unwrap();
        let entries = read_entries(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["timestampMs"], 1_700_000_000_000_u64);
        assert_eq!(entries[0]["level"], "error");
        assert_eq!(entries[0]["connectionStage"], "authenticating");
        assert_eq!(entries[0]["errorCode"], "authentication_rejected");
        assert!(!raw.contains("password"));
        assert!(!raw.contains("privateKey"));
        assert!(!raw.contains("terminalInput"));
        assert!(!raw.contains("authenticationAnswer"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn filters_events_using_the_runtime_log_level() {
        let directory = test_directory();
        let path = directory.join(LOG_FILE_NAME);
        let logger = AppLogger::new(path.clone(), LogLevel::Warn, 4096, 2).unwrap();
        logger.log_at(
            1_700_000_000_000,
            LogLevel::Info,
            "filtered",
            LogFields::default(),
        );
        logger.log_at(
            1_700_000_000_001,
            LogLevel::Warn,
            "included",
            LogFields::default(),
        );
        logger.set_level(LogLevel::Debug);
        logger.log_at(
            1_700_000_000_002,
            LogLevel::Debug,
            "runtime_debug",
            LogFields::default(),
        );

        let entries = read_entries(&path);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["event"], "included");
        assert_eq!(entries[1]["event"], "runtime_debug");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rotates_by_size_and_keeps_the_configured_backups() {
        let directory = test_directory();
        let path = directory.join(LOG_FILE_NAME);
        let logger = AppLogger::new(path.clone(), LogLevel::Info, 1, 2).unwrap();
        for timestamp in 1_700_000_000_000..1_700_000_000_004 {
            logger.log_at(
                timestamp,
                LogLevel::Info,
                "rotation_test",
                LogFields::default(),
            );
        }

        assert!(path.exists());
        assert!(backup_path(&path, 1).exists());
        assert!(backup_path(&path, 2).exists());
        assert!(!backup_path(&path, 3).exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rotates_when_the_utc_day_changes() {
        let directory = test_directory();
        let path = directory.join(LOG_FILE_NAME);
        let logger = AppLogger::new(path.clone(), LogLevel::Info, 4096, 1).unwrap();
        logger.log_at(
            MILLIS_PER_DAY - 1,
            LogLevel::Info,
            "before_midnight",
            LogFields::default(),
        );
        logger.log_at(
            MILLIS_PER_DAY,
            LogLevel::Info,
            "after_midnight",
            LogFields::default(),
        );

        assert_eq!(read_entries(&path)[0]["event"], "after_midnight");
        assert_eq!(
            read_entries(&backup_path(&path, 1))[0]["event"],
            "before_midnight"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
