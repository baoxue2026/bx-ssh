use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bx_contracts::{
    ConnectionSettings, HostKeyInfo, RemoteDirectoryListing, SshConnectionStage, TransferSummary,
};
use bx_persistence::ExposeSecret;
use bx_ssh_core::{
    authenticate_password_with_progress, authenticate_private_key_contents_with_progress,
    ClientSession, SftpClient, SshEndpoint, SshError,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

use crate::command_error::CommandError;
use crate::connections::ConnectionRepositoryState;
use crate::lifecycle::{ActivityGuard, AppActivity};
use crate::private_keys::resolve_private_key;
use crate::session_manager::{SessionKind, SshConnectionEvent, SshSessionManager};

#[derive(Clone, Default)]
pub(crate) struct SftpSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<ManagedSftpSession>>>>>,
    activity: AppActivity,
}

struct ManagedSftpSession {
    ssh: Option<ClientSession>,
    sftp: SftpClient,
    _activity_guard: ActivityGuard,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartSftpRequest {
    attempt_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    expected_fingerprint: String,
    settings: ConnectionSettings,
    initial_path: Option<String>,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartSftpResponse {
    session_id: String,
    host_key: HostKeyInfo,
    directory: RemoteDirectoryListing,
}

#[tauri::command]
pub(crate) async fn start_password_sftp(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    request: StartSftpRequest,
    on_state: Channel<SshConnectionEvent>,
) -> Result<StartSftpResponse, CommandError> {
    let owner = window.label().to_owned();
    let endpoint = SshEndpoint::new(request.host.clone(), request.port)?
        .with_connection_settings(request.settings);
    let cancellation =
        session_manager.begin_attempt(&owner, &request.attempt_id, SessionKind::Sftp)?;
    let _ = on_state.send(SshConnectionEvent {
        attempt_id: request.attempt_id.clone(),
        stage: SshConnectionStage::Created,
    });
    let ssh = authenticate_password_with_progress(
        &endpoint,
        &request.username,
        &request.expected_fingerprint,
        &request.password,
        &cancellation,
        |stage| {
            if let Ok(event) =
                session_manager.transition_attempt(&owner, &request.attempt_id, stage)
            {
                let _ = on_state.send(event);
            }
        },
    )
    .await;
    let ssh = match ssh {
        Ok(ssh) => ssh,
        Err(error) => {
            finish_connection_attempt(
                &session_manager,
                &owner,
                &request.attempt_id,
                &on_state,
                &error,
            );
            return Err(error.into());
        }
    };
    let host_key = ssh.host_key().clone();
    let opening = session_manager.transition_attempt(
        &owner,
        &request.attempt_id,
        SshConnectionStage::OpeningChannel,
    )?;
    let _ = on_state.send(opening);
    let sftp = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(SshError::ConnectionCancelled),
        result = ssh.open_sftp() => result,
    };
    let sftp = match sftp {
        Ok(sftp) => sftp,
        Err(error) => {
            let _ = ssh.disconnect().await;
            finish_connection_attempt(
                &session_manager,
                &owner,
                &request.attempt_id,
                &on_state,
                &error,
            );
            return Err(connection_error(error, SshConnectionStage::OpeningChannel));
        }
    };
    let initial_path = request.initial_path.as_deref().unwrap_or(".");
    let directory = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(SshError::ConnectionCancelled),
        result = sftp.list_directory(initial_path) => result,
    };
    let directory = match directory {
        Ok(directory) => directory,
        Err(error) => {
            let _ = sftp.close().await;
            let _ = ssh.disconnect().await;
            finish_connection_attempt(
                &session_manager,
                &owner,
                &request.attempt_id,
                &on_state,
                &error,
            );
            return Err(connection_error(error, SshConnectionStage::OpeningChannel));
        }
    };
    let (session_id, connected) =
        match session_manager.complete_attempt(&owner, &request.attempt_id) {
            Ok(result) => result,
            Err(error) => {
                let _ = sftp.close().await;
                let _ = ssh.disconnect().await;
                if let Some(event) = session_manager.finish_attempt(
                    &owner,
                    &request.attempt_id,
                    SshConnectionStage::Failed,
                ) {
                    let _ = on_state.send(event);
                }
                return Err(error);
            }
        };
    let _ = on_state.send(connected);
    let activity_guard = manager.activity.track_session();

    manager.sessions.lock().await.insert(
        session_id.clone(),
        Arc::new(Mutex::new(ManagedSftpSession {
            ssh: Some(ssh),
            sftp,
            _activity_guard: activity_guard,
        })),
    );

    Ok(StartSftpResponse {
        session_id,
        host_key,
        directory,
    })
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartPrivateKeySftpRequest {
    attempt_id: String,
    host: String,
    port: u16,
    username: String,
    key_reference_id: String,
    passphrase: Option<String>,
    expected_fingerprint: String,
    settings: ConnectionSettings,
    initial_path: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn start_private_key_sftp(
    app: AppHandle,
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    repository: State<'_, ConnectionRepositoryState>,
    request: StartPrivateKeySftpRequest,
    on_state: Channel<SshConnectionEvent>,
) -> Result<StartSftpResponse, CommandError> {
    let owner = window.label().to_owned();
    let endpoint = SshEndpoint::new(request.host.clone(), request.port)?
        .with_connection_settings(request.settings);
    let cancellation =
        session_manager.begin_attempt(&owner, &request.attempt_id, SessionKind::Sftp)?;
    let _ = on_state.send(SshConnectionEvent {
        attempt_id: request.attempt_id.clone(),
        stage: SshConnectionStage::Created,
    });

    let key = match resolve_private_key(
        &app,
        &repository,
        &request.key_reference_id,
        request.passphrase,
    )
    .await
    {
        Ok(key) => key,
        Err(error) => {
            if let Some(event) = session_manager.finish_attempt(
                &owner,
                &request.attempt_id,
                SshConnectionStage::Failed,
            ) {
                let _ = on_state.send(event);
            }
            return Err(error);
        }
    };
    let passphrase = key.passphrase.as_ref().map(|value| value.expose_secret());
    let ssh = authenticate_private_key_contents_with_progress(
        &endpoint,
        &request.username,
        &request.expected_fingerprint,
        key.contents.expose_secret(),
        passphrase,
        &cancellation,
        |stage| {
            if let Ok(event) =
                session_manager.transition_attempt(&owner, &request.attempt_id, stage)
            {
                let _ = on_state.send(event);
            }
        },
    )
    .await;
    let ssh = match ssh {
        Ok(ssh) => ssh,
        Err(error) => {
            finish_connection_attempt(
                &session_manager,
                &owner,
                &request.attempt_id,
                &on_state,
                &error,
            );
            return Err(error.into());
        }
    };
    let host_key = ssh.host_key().clone();
    let opening = session_manager.transition_attempt(
        &owner,
        &request.attempt_id,
        SshConnectionStage::OpeningChannel,
    )?;
    let _ = on_state.send(opening);
    let sftp = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(SshError::ConnectionCancelled),
        result = ssh.open_sftp() => result,
    };
    let sftp = match sftp {
        Ok(sftp) => sftp,
        Err(error) => {
            let _ = ssh.disconnect().await;
            finish_connection_attempt(
                &session_manager,
                &owner,
                &request.attempt_id,
                &on_state,
                &error,
            );
            return Err(connection_error(error, SshConnectionStage::OpeningChannel));
        }
    };
    let initial_path = request.initial_path.as_deref().unwrap_or(".");
    let directory = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(SshError::ConnectionCancelled),
        result = sftp.list_directory(initial_path) => result,
    };
    let directory = match directory {
        Ok(directory) => directory,
        Err(error) => {
            let _ = sftp.close().await;
            let _ = ssh.disconnect().await;
            finish_connection_attempt(
                &session_manager,
                &owner,
                &request.attempt_id,
                &on_state,
                &error,
            );
            return Err(connection_error(error, SshConnectionStage::OpeningChannel));
        }
    };
    let (session_id, connected) =
        match session_manager.complete_attempt(&owner, &request.attempt_id) {
            Ok(result) => result,
            Err(error) => {
                let _ = sftp.close().await;
                let _ = ssh.disconnect().await;
                if let Some(event) = session_manager.finish_attempt(
                    &owner,
                    &request.attempt_id,
                    SshConnectionStage::Failed,
                ) {
                    let _ = on_state.send(event);
                }
                return Err(error);
            }
        };
    let _ = on_state.send(connected);
    let activity_guard = manager.activity.track_session();
    manager.sessions.lock().await.insert(
        session_id.clone(),
        Arc::new(Mutex::new(ManagedSftpSession {
            ssh: Some(ssh),
            sftp,
            _activity_guard: activity_guard,
        })),
    );

    Ok(StartSftpResponse {
        session_id,
        host_key,
        directory,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn list_sftp_directory(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    path: String,
) -> Result<RemoteDirectoryListing, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.list_directory(&path).await?)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_sftp_file(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
    language: String,
) -> Result<TransferSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let _transfer_guard = manager.activity.track_transfer();
    let session = session.lock().await;
    let summary = session
        .sftp
        .upload_file(PathBuf::from(local_path), &remote_path)
        .await?;
    drop(session);
    notify_transfer_completed(
        &app,
        localized_transfer_title(&language, "上传完成", "Upload complete"),
        &remote_path,
    );
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_sftp_file(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
    language: String,
) -> Result<TransferSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let _transfer_guard = manager.activity.track_transfer();
    let session = session.lock().await;
    let summary = session
        .sftp
        .download_file(&remote_path, PathBuf::from(local_path))
        .await?;
    drop(session);
    notify_transfer_completed(
        &app,
        localized_transfer_title(&language, "下载完成", "Download complete"),
        &remote_path,
    );
    Ok(summary)
}

fn notify_transfer_completed(app: &AppHandle, title: &str, path: &str) {
    let window_is_focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if window_is_focused {
        return;
    }

    let _ = app.notification().builder().title(title).body(path).show();
}

fn localized_transfer_title<'a>(language: &str, chinese: &'a str, english: &'a str) -> &'a str {
    if language.eq_ignore_ascii_case("zh-CN") || language.eq_ignore_ascii_case("zh") {
        chinese
    } else {
        english
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn hash_remote_sftp_file(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    remote_path: String,
) -> Result<TransferSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.hash_remote_file(&remote_path).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn close_sftp_session(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager
        .sessions
        .lock()
        .await
        .remove(&session_id)
        .ok_or_else(|| CommandError::session_not_found("SFTP"))?;
    let mut session = session.lock().await;
    let sftp_result = session.sftp.close().await;
    let ssh_result = match session.ssh.take() {
        Some(ssh) => ssh.disconnect().await,
        None => Ok(()),
    };
    session_manager.remove_session(&session_id, SessionKind::Sftp);
    sftp_result?;
    ssh_result?;
    Ok(())
}

fn finish_connection_attempt(
    manager: &SshSessionManager,
    owner: &str,
    attempt_id: &str,
    channel: &Channel<SshConnectionEvent>,
    error: &SshError,
) {
    let stage = if matches!(error, SshError::ConnectionCancelled) {
        SshConnectionStage::Cancelled
    } else {
        SshConnectionStage::Failed
    };
    if let Some(event) = manager.finish_attempt(owner, attempt_id, stage) {
        let _ = channel.send(event);
    }
}

fn connection_error(error: SshError, fallback_stage: SshConnectionStage) -> CommandError {
    let mut error = CommandError::from(error);
    if error.stage.is_none() {
        error.stage = Some(fallback_stage);
    }
    error
}

impl SftpSessionManager {
    pub(crate) fn with_activity(activity: AppActivity) -> Self {
        Self {
            sessions: Arc::default(),
            activity,
        }
    }

    pub(crate) async fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();

        for session in sessions {
            let Ok(session) = Arc::try_unwrap(session) else {
                continue;
            };
            let mut session = session.into_inner();
            let _ = session.sftp.close().await;
            if let Some(ssh) = session.ssh.take() {
                let _ = ssh.disconnect().await;
            }
        }
    }

    async fn get(&self, session_id: &str) -> Result<Arc<Mutex<ManagedSftpSession>>, CommandError> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| CommandError::session_not_found("SFTP"))
    }
}

#[cfg(test)]
mod tests {
    use super::{localized_transfer_title, SftpSessionManager};
    use crate::command_error::CommandErrorCode;

    #[tokio::test]
    async fn rejects_unknown_sftp_session_handles() {
        let manager = SftpSessionManager::default();
        let Err(error) = manager.get("missing").await else {
            panic!("missing SFTP session unexpectedly resolved");
        };

        assert_eq!(error.code, CommandErrorCode::SessionNotFound);
    }

    #[test]
    fn localizes_background_transfer_notifications() {
        assert_eq!(
            localized_transfer_title("zh-CN", "上传完成", "Upload complete"),
            "上传完成"
        );
        assert_eq!(
            localized_transfer_title("en-US", "上传完成", "Upload complete"),
            "Upload complete"
        );
    }
}
