use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bx_contracts::{
    ConnectionSettings, HostKeyInfo, RemoteDirectoryListing, RemoteFileEntry, SftpConflictAction,
    SshConnectionStage, TransferBatchSummary, TransferSummary,
};
use bx_persistence::ExposeSecret;
use bx_ssh_core::{
    authenticate_password_with_progress, authenticate_private_key_contents_with_progress,
    ClientSession, ConnectionCancellation, SftpClient, SshEndpoint, SshError,
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
    transfers: Arc<Mutex<HashMap<String, ManagedSftpTransfer>>>,
    activity: AppActivity,
}

struct ManagedSftpTransfer {
    owner: String,
    session_id: String,
    cancellation: ConnectionCancellation,
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
pub(crate) async fn stat_sftp_path(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    path: String,
) -> Result<RemoteFileEntry, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.stat_path(&path).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn create_sftp_directory(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    remote_path: String,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.create_directory(&remote_path).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_sftp_entry(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    remote_path: String,
    recursive: bool,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.delete_entry(&remote_path, recursive).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn move_sftp_entry(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    source_path: String,
    target_path: String,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.move_entry(&source_path, &target_path).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn rename_sftp_entry(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    source_path: String,
    target_path: String,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session
        .sftp
        .rename_entry(&source_path, &target_path)
        .await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn chmod_sftp_entry(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    remote_path: String,
    permissions: u32,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.chmod(&remote_path, permissions).await?)
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
pub(crate) async fn upload_sftp_file_with_conflict(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
    language: String,
    conflict_action: SftpConflictAction,
) -> Result<Option<TransferSummary>, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let _transfer_guard = manager.activity.track_transfer();
    let session = session.lock().await;
    let summary = session
        .sftp
        .upload_file_with_conflict(PathBuf::from(local_path), &remote_path, conflict_action)
        .await?;
    drop(session);
    if summary.is_some() {
        notify_transfer_completed(
            &app,
            localized_transfer_title(&language, "上传完成", "Upload complete"),
            &remote_path,
        );
    }
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

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_sftp_file_with_conflict(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
    language: String,
    conflict_action: SftpConflictAction,
) -> Result<Option<TransferSummary>, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let _transfer_guard = manager.activity.track_transfer();
    let session = session.lock().await;
    let summary = session
        .sftp
        .download_file_with_conflict(&remote_path, PathBuf::from(local_path), conflict_action)
        .await?;
    drop(session);
    if summary.is_some() {
        notify_transfer_completed(
            &app,
            localized_transfer_title(&language, "下载完成", "Download complete"),
            &remote_path,
        );
    }
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_sftp_directory(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    language: String,
) -> Result<TransferBatchSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let cancellation = manager
        .begin_transfer(window.label(), &session_id, &transfer_id)
        .await?;
    let _transfer_guard = manager.activity.track_transfer();
    let result = {
        let session = session.lock().await;
        session
            .sftp
            .upload_directory(PathBuf::from(local_path), &remote_path, &cancellation)
            .await
    };
    manager.finish_transfer(&transfer_id).await;
    let summary = result?;
    notify_transfer_completed(
        &app,
        localized_transfer_title(&language, "目录上传完成", "Directory upload complete"),
        &remote_path,
    );
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_sftp_directory_with_conflict(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    language: String,
    conflict_action: SftpConflictAction,
) -> Result<TransferBatchSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let cancellation = manager
        .begin_transfer(window.label(), &session_id, &transfer_id)
        .await?;
    let _transfer_guard = manager.activity.track_transfer();
    let result = {
        let session = session.lock().await;
        session
            .sftp
            .upload_directory_with_conflict(
                PathBuf::from(local_path),
                &remote_path,
                &cancellation,
                conflict_action,
            )
            .await
    };
    manager.finish_transfer(&transfer_id).await;
    let summary = result?;
    notify_transfer_completed(
        &app,
        localized_transfer_title(&language, "目录上传完成", "Directory upload complete"),
        &remote_path,
    );
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_sftp_directory(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    language: String,
) -> Result<TransferBatchSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let cancellation = manager
        .begin_transfer(window.label(), &session_id, &transfer_id)
        .await?;
    let _transfer_guard = manager.activity.track_transfer();
    let result = {
        let session = session.lock().await;
        session
            .sftp
            .download_directory(&remote_path, PathBuf::from(local_path), &cancellation)
            .await
    };
    manager.finish_transfer(&transfer_id).await;
    let summary = result?;
    notify_transfer_completed(
        &app,
        localized_transfer_title(&language, "目录下载完成", "Directory download complete"),
        &remote_path,
    );
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_sftp_directory_with_conflict(
    window: WebviewWindow,
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    language: String,
    conflict_action: SftpConflictAction,
) -> Result<TransferBatchSummary, CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Sftp)?;
    let session = manager.get(&session_id).await?;
    let cancellation = manager
        .begin_transfer(window.label(), &session_id, &transfer_id)
        .await?;
    let _transfer_guard = manager.activity.track_transfer();
    let result = {
        let session = session.lock().await;
        session
            .sftp
            .download_directory_with_conflict(
                &remote_path,
                PathBuf::from(local_path),
                &cancellation,
                conflict_action,
            )
            .await
    };
    manager.finish_transfer(&transfer_id).await;
    let summary = result?;
    notify_transfer_completed(
        &app,
        localized_transfer_title(&language, "目录下载完成", "Directory download complete"),
        &remote_path,
    );
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cancel_sftp_transfer(
    window: WebviewWindow,
    manager: State<'_, SftpSessionManager>,
    transfer_id: String,
) -> Result<bool, CommandError> {
    Ok(manager.cancel_transfer(window.label(), &transfer_id).await)
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
    manager.cancel_session_transfers(&session_id).await;
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
            transfers: Arc::default(),
            activity,
        }
    }

    pub(crate) async fn close_all(&self) {
        self.cancel_all_transfers().await;
        let sessions = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();

        for session in sessions {
            let mut session = session.lock().await;
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

    async fn begin_transfer(
        &self,
        owner: &str,
        session_id: &str,
        transfer_id: &str,
    ) -> Result<ConnectionCancellation, CommandError> {
        let transfer_id = validate_transfer_id(transfer_id)?;
        let cancellation = ConnectionCancellation::default();
        let mut transfers = self.transfers.lock().await;
        if transfers.contains_key(transfer_id) {
            return Err(CommandError::new(
                crate::command_error::CommandErrorCode::SessionStateInvalid,
                "SFTP transfer ID is already active",
            ));
        }
        transfers.insert(
            transfer_id.to_owned(),
            ManagedSftpTransfer {
                owner: owner.to_owned(),
                session_id: session_id.to_owned(),
                cancellation: cancellation.clone(),
            },
        );
        Ok(cancellation)
    }

    async fn finish_transfer(&self, transfer_id: &str) {
        self.transfers.lock().await.remove(transfer_id);
    }

    async fn cancel_transfer(&self, owner: &str, transfer_id: &str) -> bool {
        let transfers = self.transfers.lock().await;
        let Some(transfer) = transfers.get(transfer_id) else {
            return false;
        };
        if transfer.owner != owner {
            return false;
        }
        transfer.cancellation.cancel();
        true
    }

    async fn cancel_session_transfers(&self, session_id: &str) {
        for transfer in self.transfers.lock().await.values() {
            if transfer.session_id == session_id {
                transfer.cancellation.cancel();
            }
        }
    }

    async fn cancel_all_transfers(&self) {
        for transfer in self.transfers.lock().await.values() {
            transfer.cancellation.cancel();
        }
    }
}

fn validate_transfer_id(transfer_id: &str) -> Result<&str, CommandError> {
    let valid = uuid::Uuid::parse_str(transfer_id)
        .ok()
        .is_some_and(|id| id.get_version() == Some(uuid::Version::Random));
    if valid {
        Ok(transfer_id)
    } else {
        Err(CommandError::new(
            crate::command_error::CommandErrorCode::InvalidTransferId,
            "SFTP transfer ID must be a random UUID",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{localized_transfer_title, validate_transfer_id, SftpSessionManager};
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

    #[tokio::test]
    async fn scopes_directory_transfer_cancellation_to_its_owner() {
        const TRANSFER_ID: &str = "75e95ca2-bb25-45d8-8ca9-d9a87d67a4fd";
        let manager = SftpSessionManager::default();
        let cancellation = manager
            .begin_transfer("main", "sftp-1", TRANSFER_ID)
            .await
            .unwrap();

        assert!(!manager.cancel_transfer("other", TRANSFER_ID).await);
        assert!(!cancellation.is_cancelled());
        assert!(manager.cancel_transfer("main", TRANSFER_ID).await);
        assert!(cancellation.is_cancelled());

        manager.finish_transfer(TRANSFER_ID).await;
        assert!(!manager.cancel_transfer("main", TRANSFER_ID).await);
        assert!(validate_transfer_id("transfer-1").is_err());
    }
}
