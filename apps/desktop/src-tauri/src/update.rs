use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Error as UpdaterError, UpdaterExt};

use crate::command_error::{CommandError, CommandErrorCode};

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

    let _ = on_event.send(UpdateEvent::Verified);
    update.install(bytes).map_err(map_updater_error)?;

    app.restart();
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
    CommandError::update(code, message)
}

#[cfg(test)]
mod tests {
    use super::{map_updater_error, UpdateEvent, UpdaterError};
    use crate::command_error::CommandErrorCode;

    #[test]
    fn maps_insecure_update_endpoints_to_a_stable_error() {
        let error = map_updater_error(UpdaterError::InsecureTransportProtocol);

        assert_eq!(error.code, CommandErrorCode::UpdateInsecureEndpoint);
        assert_eq!(error.message, "The update endpoint must use HTTPS");
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
}
