use std::collections::HashMap;
use std::sync::Arc;

use bx_contracts::HostKeyInfo;
use bx_ssh_core::{
    authenticate_password, probe_host_key, ClientSession, ShellEvent, SshEndpoint, SshError,
    SshShell, TerminalSize,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

const COMMAND_QUEUE_CAPACITY: usize = 128;

#[derive(Clone, Default)]
pub(crate) struct TerminalSessionManager {
    sessions: Arc<Mutex<HashMap<String, mpsc::Sender<SessionCommand>>>>,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeHostRequest {
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartShellRequest {
    host: String,
    port: u16,
    username: String,
    password: String,
    expected_fingerprint: String,
    columns: u32,
    rows: u32,
    pixel_width: u32,
    pixel_height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartShellResponse {
    session_id: String,
    host_key: HostKeyInfo,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TerminalEvent {
    Output {
        data: Vec<u8>,
    },
    Exited {
        code: Option<u32>,
        signal: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: String,
    message: String,
}

#[tauri::command]
pub(crate) async fn probe_ssh_host(request: ProbeHostRequest) -> Result<HostKeyInfo, CommandError> {
    let endpoint = SshEndpoint::new(request.host, request.port)?;
    Ok(probe_host_key(&endpoint).await?)
}

#[tauri::command]
pub(crate) async fn start_password_shell(
    manager: State<'_, TerminalSessionManager>,
    request: StartShellRequest,
    on_event: Channel<TerminalEvent>,
) -> Result<StartShellResponse, CommandError> {
    let endpoint = SshEndpoint::new(request.host, request.port)?;
    let size = TerminalSize::with_pixels(
        request.columns,
        request.rows,
        request.pixel_width,
        request.pixel_height,
    )?;
    let session = authenticate_password(
        &endpoint,
        &request.username,
        &request.expected_fingerprint,
        &request.password,
    )
    .await?;
    let host_key = session.host_key().clone();
    let shell = session.open_shell(size).await?;
    let session_id = Uuid::new_v4().to_string();
    let (command_tx, command_rx) = mpsc::channel(COMMAND_QUEUE_CAPACITY);

    manager
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), command_tx);

    let task_manager = manager.inner().clone();
    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        run_session(
            task_manager,
            task_session_id,
            session,
            shell,
            command_rx,
            on_event,
        )
        .await;
    });

    Ok(StartShellResponse {
        session_id,
        host_key,
    })
}

#[tauri::command]
pub(crate) async fn write_terminal(
    manager: State<'_, TerminalSessionManager>,
    session_id: String,
    data: String,
) -> Result<(), CommandError> {
    manager
        .send(&session_id, SessionCommand::Write(data.into_bytes()))
        .await
}

#[tauri::command]
pub(crate) async fn resize_terminal(
    manager: State<'_, TerminalSessionManager>,
    session_id: String,
    columns: u32,
    rows: u32,
    pixel_width: u32,
    pixel_height: u32,
) -> Result<(), CommandError> {
    let size = TerminalSize::with_pixels(columns, rows, pixel_width, pixel_height)?;
    manager
        .send(&session_id, SessionCommand::Resize(size))
        .await
}

#[tauri::command]
pub(crate) async fn close_terminal_session(
    manager: State<'_, TerminalSessionManager>,
    session_id: String,
) -> Result<(), CommandError> {
    let sender = manager
        .sessions
        .lock()
        .await
        .remove(&session_id)
        .ok_or_else(CommandError::session_not_found)?;
    sender
        .send(SessionCommand::Close)
        .await
        .map_err(|_| CommandError::session_closed())
}

impl TerminalSessionManager {
    async fn send(&self, session_id: &str, command: SessionCommand) -> Result<(), CommandError> {
        let sender = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(CommandError::session_not_found)?;
        sender
            .send(command)
            .await
            .map_err(|_| CommandError::session_closed())
    }
}

async fn run_session(
    manager: TerminalSessionManager,
    session_id: String,
    session: ClientSession,
    mut shell: SshShell,
    mut commands: mpsc::Receiver<SessionCommand>,
    on_event: Channel<TerminalEvent>,
) {
    let mut exit_code = None;
    let mut exit_signal = None;

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Write(data)) => {
                        if let Err(error) = shell.write(data).await {
                            send_error(&on_event, error);
                            break;
                        }
                    }
                    Some(SessionCommand::Resize(size)) => {
                        if let Err(error) = shell.resize(size).await {
                            send_error(&on_event, error);
                            break;
                        }
                    }
                    Some(SessionCommand::Close) | None => {
                        if let Err(error) = shell.close().await {
                            send_error(&on_event, error);
                        }
                        break;
                    }
                }
            }
            event = shell.next_event() => {
                match event {
                    Ok(ShellEvent::Output(data))
                    | Ok(ShellEvent::ExtendedOutput { data, .. }) => {
                        if on_event.send(TerminalEvent::Output { data }).is_err() {
                            break;
                        }
                    }
                    Ok(ShellEvent::ExitStatus(code)) => exit_code = Some(code),
                    Ok(ShellEvent::ExitSignal { signal, .. }) => exit_signal = Some(signal),
                    Ok(ShellEvent::Eof) => {}
                    Ok(ShellEvent::Closed) => break,
                    Err(error) => {
                        send_error(&on_event, error);
                        break;
                    }
                }
            }
        }
    }

    let _ = on_event.send(TerminalEvent::Exited {
        code: exit_code,
        signal: exit_signal,
    });
    manager.sessions.lock().await.remove(&session_id);
    drop(shell);
    let _ = session.disconnect().await;
}

fn send_error(channel: &Channel<TerminalEvent>, error: SshError) {
    let error = CommandError::from(error);
    let _ = channel.send(TerminalEvent::Error {
        code: error.code,
        message: error.message,
    });
}

impl CommandError {
    fn session_not_found() -> Self {
        Self {
            code: "session_not_found".to_owned(),
            message: "terminal session was not found".to_owned(),
        }
    }

    fn session_closed() -> Self {
        Self {
            code: "session_closed".to_owned(),
            message: "terminal session is already closed".to_owned(),
        }
    }
}

impl From<SshError> for CommandError {
    fn from(error: SshError) -> Self {
        let code = match &error {
            SshError::InvalidHost => "invalid_host",
            SshError::InvalidPort => "invalid_port",
            SshError::InvalidUsername => "invalid_username",
            SshError::InvalidFingerprint => "invalid_fingerprint",
            SshError::InvalidTerminalSize => "invalid_terminal_size",
            SshError::ConnectTimeout => "connect_timeout",
            SshError::AuthenticationTimeout => "authentication_timeout",
            SshError::HostKeyUnavailable => "host_key_unavailable",
            SshError::HostKeyMismatch { .. } => "host_key_mismatch",
            SshError::AuthenticationRejected { .. } => "authentication_rejected",
            SshError::LegacyRsaSignatureOnly => "legacy_rsa_signature_only",
            SshError::ChannelRequestRejected { .. } => "channel_request_rejected",
            SshError::ChannelClosed { .. } => "channel_closed",
            SshError::PrivateKey(_) => "private_key_error",
            SshError::Transport(_) => "transport_error",
        };

        Self {
            code: code.to_owned(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandError, TerminalSessionManager};
    use bx_ssh_core::SshError;

    #[test]
    fn maps_ssh_errors_to_stable_codes() {
        let error = CommandError::from(SshError::HostKeyMismatch {
            expected: "SHA256:expected".to_owned(),
            actual: "SHA256:actual".to_owned(),
        });

        assert_eq!(error.code, "host_key_mismatch");
    }

    #[tokio::test]
    async fn rejects_unknown_session_handles() {
        let manager = TerminalSessionManager::default();
        let error = manager
            .send("missing", super::SessionCommand::Write(Vec::new()))
            .await
            .unwrap_err();

        assert_eq!(error.code, "session_not_found");
    }
}
