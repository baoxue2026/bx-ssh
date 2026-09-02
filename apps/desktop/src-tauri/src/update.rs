use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Error as UpdaterError, UpdaterExt};
use uuid::Uuid;

use crate::command_error::{CommandError, CommandErrorCode};
use crate::connections::{app_data_directory, run_query, ConnectionRepositoryState};

const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    current_version: String,
    version: String,
    notes: Option<String>,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum UpdateEvent {
    Started {
        #[serde(rename = "contentLength")]
        #[specta(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        #[specta(rename = "chunkLength")]
        chunk_length: usize,
    },
    Verified,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, CommandError> {
    let update = app
        .updater_builder()
        .timeout(UPDATE_TIMEOUT)
        .build()
        .map_err(map_updater_error)?
        .check()
        .await
        .map_err(map_updater_error)?;

    Ok(update.map(|update| UpdateInfo {
        current_version: update.current_version,
        version: update.version,
        notes: update.body,
        published_at: update.date.map(|date| date.to_string()),
    }))
}

#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    expected_version: String,
    on_event: Channel<UpdateEvent>,
) -> Result<(), CommandError> {
    let update = app
        .updater_builder()
        .timeout(UPDATE_TIMEOUT)
        .build()
        .map_err(map_updater_error)?
        .check()
        .await
        .map_err(map_updater_error)?
        .ok_or_else(|| {
            CommandError::update(
                CommandErrorCode::UpdateNotAvailable,
                "No update is available",
            )
        })?;

    if update.version != expected_version {
        return Err(CommandError::update(
            CommandErrorCode::UpdateChanged,
            "The available update changed; check again before installing",
        ));
    }

    if !is_strictly_newer_version(&update.current_version, &update.version) {
        return Err(CommandError::update(
            CommandErrorCode::UpdateChanged,
            "The available update is not newer than the installed version",
        ));
    }

    let progress_channel = on_event.clone();
    let mut started = false;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress_channel.send(UpdateEvent::Started { content_length });
                }
                let _ = progress_channel.send(UpdateEvent::Progress { chunk_length });
            },
            || {},
        )
        .await
        .map_err(map_updater_error)?;

    // Download() returns only after the updater has verified the package signature.
    // The database backup is deliberately performed after verification and immediately
    // before install, so a failed backup can never leave the app half-updated.
    let data_directory = app_data_directory(&app)?;
    let backup_path = update_backup_path(&data_directory, &update.current_version);
    fs::create_dir_all(backup_path.parent().unwrap_or(&data_directory)).map_err(|_| {
        let command_error = CommandError::update(
            CommandErrorCode::UpdateBackupFailed,
            "Unable to create the pre-update database backup",
        );
        crate::logging::command_error(
            "update_backup_failed",
            &command_error,
            crate::logging::LogFields::default(),
        );
        command_error
    })?;
    if let Err(error) = run_query(state.inner().clone(), data_directory, {
        let backup_path = backup_path.clone();
        move |repository| repository.backup_to(&backup_path)
    })
    .await
    {
        let command_error = CommandError::update(
            CommandErrorCode::UpdateBackupFailed,
            "Unable to create the pre-update database backup",
        );
        crate::logging::command_error(
            "update_backup_failed",
            &command_error,
            crate::logging::LogFields::default(),
        );
        let _ = error;
        return Err(command_error);
    }

    let _ = on_event.send(UpdateEvent::Verified);
    update.install(bytes).map_err(map_updater_error)?;

    app.restart();
}

fn is_strictly_newer_version(current: &str, candidate: &str) -> bool {
    let Ok(current) = semver::Version::parse(current) else {
        return false;
    };
    let Ok(candidate) = semver::Version::parse(candidate) else {
        return false;
    };
    candidate > current
}

fn update_backup_path(data_directory: &Path, current_version: &str) -> PathBuf {
    let version = current_version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    data_directory
        .join("backups")
        .join(format!("bx-ssh-update-{version}-{}.db", Uuid::new_v4()))
}

fn map_updater_error(error: UpdaterError) -> CommandError {
    let code = match &error {
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            CommandErrorCode::UpdateSignatureInvalid
        }
        UpdaterError::InsecureTransportProtocol => CommandErrorCode::UpdateInsecureEndpoint,
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) | UpdaterError::ReleaseNotFound => {
            CommandErrorCode::UpdateUnavailable
        }
        _ => CommandErrorCode::UpdateFailed,
    };
    let message = match code {
        CommandErrorCode::UpdateSignatureInvalid => {
            "Update signature verification failed".to_owned()
        }
        CommandErrorCode::UpdateInsecureEndpoint => "The update endpoint must use HTTPS".to_owned(),
        _ => error.to_string(),
    };
    let error = CommandError::update(code, message);
    crate::logging::command_error(
        "update_failed",
        &error,
        crate::logging::LogFields::default(),
    );
    error
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        is_strictly_newer_version, map_updater_error, update_backup_path, UpdateEvent, UpdaterError,
    };
    use crate::command_error::CommandErrorCode;

    #[test]
    fn maps_insecure_update_endpoints_to_a_stable_error() {
        let error = map_updater_error(UpdaterError::InsecureTransportProtocol);

        assert_eq!(error.code, CommandErrorCode::UpdateInsecureEndpoint);
        assert_eq!(error.message, "The update endpoint must use HTTPS");
    }

    #[test]
    fn maps_invalid_update_signatures_to_a_stable_error() {
        let error = map_updater_error(UpdaterError::SignatureUtf8("malformed".to_owned()));

        assert_eq!(error.code, CommandErrorCode::UpdateSignatureInvalid);
        assert_eq!(error.message, "Update signature verification failed");
    }

    #[test]
    fn serializes_update_progress_with_camel_case_fields() {
        let started = serde_json::to_value(UpdateEvent::Started {
            content_length: Some(1024),
        })
        .expect("update event must serialize");
        let progress = serde_json::to_value(UpdateEvent::Progress { chunk_length: 512 })
            .expect("update event must serialize");

        assert_eq!(started["contentLength"], 1024);
        assert_eq!(progress["chunkLength"], 512);
    }

    #[test]
    fn accepts_only_strictly_newer_semver_updates() {
        assert!(is_strictly_newer_version("0.1.0", "0.2.0"));
        assert!(is_strictly_newer_version("1.0.0-beta.1", "1.0.0"));
        assert!(!is_strictly_newer_version("0.2.0", "0.1.0"));
        assert!(!is_strictly_newer_version("0.2.0", "0.2.0"));
        assert!(!is_strictly_newer_version("invalid", "0.2.0"));
    }

    #[test]
    fn update_backups_are_isolated_under_the_application_data_directory() {
        let path = update_backup_path(Path::new("C:/BX SSH"), "0.1.0");

        assert_eq!(path.parent().and_then(Path::file_name).unwrap(), "backups");
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("bx-ssh-update-0.1.0-"));
        assert!(path.extension().is_some_and(|extension| extension == "db"));
    }
}
