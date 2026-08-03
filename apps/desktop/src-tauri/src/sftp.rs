use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bx_contracts::{HostKeyInfo, RemoteDirectoryListing, TransferSummary};
use bx_ssh_core::{authenticate_password, ClientSession, SftpClient, SshEndpoint};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::command_error::CommandError;
use crate::lifecycle::{ActivityGuard, AppActivity};

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
    host: String,
    port: u16,
    username: String,
    password: String,
    expected_fingerprint: String,
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
#[specta::specta]
pub(crate) async fn start_password_sftp(
    manager: State<'_, SftpSessionManager>,
    request: StartSftpRequest,
) -> Result<StartSftpResponse, CommandError> {
    let endpoint = SshEndpoint::new(request.host, request.port)?;
    let ssh = authenticate_password(
        &endpoint,
        &request.username,
        &request.expected_fingerprint,
        &request.password,
    )
    .await?;
    let host_key = ssh.host_key().clone();
    let sftp = match ssh.open_sftp().await {
        Ok(sftp) => sftp,
        Err(error) => {
            let _ = ssh.disconnect().await;
            return Err(error.into());
        }
    };
    let initial_path = request.initial_path.as_deref().unwrap_or(".");
    let directory = match sftp.list_directory(initial_path).await {
        Ok(directory) => directory,
        Err(error) => {
            let _ = sftp.close().await;
            let _ = ssh.disconnect().await;
            return Err(error.into());
        }
    };
    let session_id = Uuid::new_v4().to_string();
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
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<RemoteDirectoryListing, CommandError> {
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.list_directory(&path).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn upload_sftp_file(
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<TransferSummary, CommandError> {
    let session = manager.get(&session_id).await?;
    let _transfer_guard = manager.activity.track_transfer();
    let session = session.lock().await;
    let summary = session
        .sftp
        .upload_file(PathBuf::from(local_path), &remote_path)
        .await?;
    drop(session);
    notify_transfer_completed(&app, "上传完成", &remote_path);
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn download_sftp_file(
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<TransferSummary, CommandError> {
    let session = manager.get(&session_id).await?;
    let _transfer_guard = manager.activity.track_transfer();
    let session = session.lock().await;
    let summary = session
        .sftp
        .download_file(&remote_path, PathBuf::from(local_path))
        .await?;
    drop(session);
    notify_transfer_completed(&app, "下载完成", &remote_path);
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

#[tauri::command]
#[specta::specta]
pub(crate) async fn hash_remote_sftp_file(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    remote_path: String,
) -> Result<TransferSummary, CommandError> {
    let session = manager.get(&session_id).await?;
    let session = session.lock().await;
    Ok(session.sftp.hash_remote_file(&remote_path).await?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn close_sftp_session(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
) -> Result<(), CommandError> {
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
    sftp_result?;
    ssh_result?;
    Ok(())
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
    use super::SftpSessionManager;
    use crate::command_error::CommandErrorCode;

    #[tokio::test]
    async fn rejects_unknown_sftp_session_handles() {
        let manager = SftpSessionManager::default();
        let Err(error) = manager.get("missing").await else {
            panic!("missing SFTP session unexpectedly resolved");
        };

        assert_eq!(error.code, CommandErrorCode::SessionNotFound);
    }
}
