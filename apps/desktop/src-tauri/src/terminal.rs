use std::collections::{HashMap, VecDeque};
use std::future::pending;
use std::sync::Arc;
use std::time::Duration;

use bx_contracts::HostKeyInfo;
use bx_ssh_core::{
    authenticate_password, probe_host_key, ClientSession, ShellEvent, SshEndpoint, SshError,
    SshShell, TerminalSize,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;
use uuid::Uuid;

const COMMAND_QUEUE_CAPACITY: usize = 128;
const OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
const OUTPUT_BATCH_MAX_DELAY: Duration = Duration::from_millis(8);
const OUTPUT_MAX_IN_FLIGHT_BATCHES: usize = 8;

#[derive(Clone, Default)]
pub(crate) struct TerminalSessionManager {
    sessions: Arc<Mutex<HashMap<String, mpsc::Sender<SessionCommand>>>>,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize(TerminalSize),
    AcknowledgeOutput(u64),
    Close,
}

struct TerminalOutputFlow {
    pending: Vec<u8>,
    pending_since: Option<Instant>,
    in_flight: VecDeque<u64>,
    next_sequence: u64,
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
    on_output: Channel<InvokeResponseBody>,
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
            on_output,
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
pub(crate) async fn acknowledge_terminal_output(
    manager: State<'_, TerminalSessionManager>,
    session_id: String,
    sequence: u64,
) -> Result<(), CommandError> {
    manager
        .send(&session_id, SessionCommand::AcknowledgeOutput(sequence))
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
    on_output: Channel<InvokeResponseBody>,
) {
    let mut exit_code = None;
    let mut exit_signal = None;
    let mut output = TerminalOutputFlow::new();

    loop {
        let flush_deadline = output.flush_deadline();
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
                    Some(SessionCommand::AcknowledgeOutput(sequence)) => {
                        output.acknowledge(sequence);
                    }
                    Some(SessionCommand::Close) | None => {
                        if let Err(error) = shell.close().await {
                            send_error(&on_event, error);
                        }
                        break;
                    }
                }
            }
            event = shell.next_event(), if output.can_read() => {
                match event {
                    Ok(ShellEvent::Output(data))
                    | Ok(ShellEvent::ExtendedOutput { data, .. }) => {
                        output.push(data);
                        if output.should_flush()
                            && output.flush(&on_output).is_err()
                        {
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
            _ = wait_for_flush(flush_deadline), if flush_deadline.is_some() => {
                if output.flush(&on_output).is_err() {
                    break;
                }
            }
        }
    }

    let _ = output.flush(&on_output);
    let _ = on_event.send(TerminalEvent::Exited {
        code: exit_code,
        signal: exit_signal,
    });
    manager.sessions.lock().await.remove(&session_id);
    drop(shell);
    let _ = session.disconnect().await;
}

impl TerminalOutputFlow {
    fn new() -> Self {
        Self {
            pending: Vec::with_capacity(OUTPUT_BATCH_MAX_BYTES),
            pending_since: None,
            in_flight: VecDeque::with_capacity(OUTPUT_MAX_IN_FLIGHT_BATCHES),
            next_sequence: 1,
        }
    }

    fn can_read(&self) -> bool {
        self.in_flight.len() < OUTPUT_MAX_IN_FLIGHT_BATCHES
    }

    fn push(&mut self, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        if self.pending.is_empty() {
            self.pending_since = Some(Instant::now());
        }
        self.pending.extend(data);
    }

    fn should_flush(&self) -> bool {
        self.pending.len() >= OUTPUT_BATCH_MAX_BYTES
    }

    fn flush_deadline(&self) -> Option<Instant> {
        self.pending_since
            .map(|started| started + OUTPUT_BATCH_MAX_DELAY)
    }

    fn flush(&mut self, channel: &Channel<InvokeResponseBody>) -> tauri::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }

        let data = std::mem::replace(
            &mut self.pending,
            Vec::with_capacity(OUTPUT_BATCH_MAX_BYTES),
        );
        channel.send(InvokeResponseBody::Raw(data))?;
        self.pending_since = None;
        self.in_flight.push_back(self.next_sequence);
        self.next_sequence += 1;
        Ok(())
    }

    fn acknowledge(&mut self, sequence: u64) {
        if sequence >= self.next_sequence {
            return;
        }

        while self
            .in_flight
            .front()
            .is_some_and(|in_flight| *in_flight <= sequence)
        {
            self.in_flight.pop_front();
        }
    }
}

async fn wait_for_flush(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending().await,
    }
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
    use std::sync::{Arc, Mutex as StdMutex};

    use super::{
        CommandError, SessionCommand, TerminalOutputFlow, TerminalSessionManager,
        OUTPUT_BATCH_MAX_BYTES, OUTPUT_MAX_IN_FLIGHT_BATCHES,
    };
    use bx_ssh_core::SshError;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::sync::mpsc;

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
            .send("missing", SessionCommand::Write(Vec::new()))
            .await
            .unwrap_err();

        assert_eq!(error.code, "session_not_found");
    }

    #[test]
    fn batches_binary_output_and_applies_backpressure() {
        let delivered = Arc::new(StdMutex::new(Vec::new()));
        let delivered_for_channel = delivered.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(data) = body {
                delivered_for_channel.lock().unwrap().push(data);
            }
            Ok(())
        });
        let mut flow = TerminalOutputFlow::new();

        for byte in 0..OUTPUT_MAX_IN_FLIGHT_BATCHES {
            for _ in 0..64 {
                flow.push(vec![byte as u8; OUTPUT_BATCH_MAX_BYTES / 64]);
                if flow.should_flush() {
                    flow.flush(&channel).unwrap();
                }
            }
        }

        assert!(!flow.can_read());
        assert_eq!(
            delivered.lock().unwrap().len(),
            OUTPUT_MAX_IN_FLIGHT_BATCHES
        );

        flow.acknowledge(OUTPUT_MAX_IN_FLIGHT_BATCHES as u64 / 2);
        assert!(flow.can_read());
        assert_eq!(flow.in_flight.len(), OUTPUT_MAX_IN_FLIGHT_BATCHES / 2);
    }

    #[test]
    fn ignores_acknowledgements_for_unsent_output() {
        let channel = Channel::new(|_| Ok(()));
        let mut flow = TerminalOutputFlow::new();
        flow.push(b"terminal output".to_vec());
        flow.flush(&channel).unwrap();

        flow.acknowledge(2);
        assert_eq!(flow.in_flight.front(), Some(&1));

        flow.acknowledge(1);
        assert!(flow.in_flight.is_empty());
    }

    #[tokio::test]
    async fn routes_commands_to_the_requested_session_only() {
        let manager = TerminalSessionManager::default();
        let (first_tx, mut first_rx) = mpsc::channel(1);
        let (second_tx, mut second_rx) = mpsc::channel(1);
        {
            let mut sessions = manager.sessions.lock().await;
            sessions.insert("first".to_owned(), first_tx);
            sessions.insert("second".to_owned(), second_tx);
        }

        assert!(manager
            .send("second", SessionCommand::AcknowledgeOutput(7))
            .await
            .is_ok());

        assert!(first_rx.try_recv().is_err());
        assert!(matches!(
            second_rx.recv().await,
            Some(SessionCommand::AcknowledgeOutput(7))
        ));
    }
}
