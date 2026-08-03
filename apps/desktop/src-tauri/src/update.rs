use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Error as UpdaterError, UpdaterExt};

use crate::command_error::CommandError;

const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    current_version: String,
    version: String,
    notes: Option<String>,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum UpdateEvent {
    Started { content_length: Option<u64> },
    Progress { chunk_length: usize },
    Verified,
}

#[tauri::command]
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
        .ok_or_else(|| CommandError::update("update_not_available", "No update is available"))?;

    if update.version != expected_version {
        return Err(CommandError::update(
            "update_changed",
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
            "update_signature_invalid"
        }
        UpdaterError::InsecureTransportProtocol => "update_insecure_endpoint",
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) | UpdaterError::ReleaseNotFound => {
            "update_unavailable"
        }
        _ => "update_failed",
    };
    let message = match code {
        "update_signature_invalid" => "Update signature verification failed".to_owned(),
        "update_insecure_endpoint" => "The update endpoint must use HTTPS".to_owned(),
        _ => error.to_string(),
    };
    CommandError::update(code, message)
}

#[cfg(test)]
mod tests {
    use super::{map_updater_error, UpdaterError};

    #[test]
    fn maps_insecure_update_endpoints_to_a_stable_error() {
        let error = map_updater_error(UpdaterError::InsecureTransportProtocol);

        assert_eq!(error.code, "update_insecure_endpoint");
        assert_eq!(error.message, "The update endpoint must use HTTPS");
    }
}
