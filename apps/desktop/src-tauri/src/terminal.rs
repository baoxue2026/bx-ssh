use std::collections::{HashMap, VecDeque};
use std::future::pending;
use std::sync::Arc;
use std::time::Duration;

use bx_contracts::{HostKeyInfo, SshConnectionStage};
use bx_ssh_core::{
    authenticate_password_with_progress, probe_host_key, ClientSession, ShellEvent, SshEndpoint,
    SshError, SshShell, TerminalSize,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::{State, WebviewWindow};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Instant;

use crate::command_error::{CommandError, CommandErrorCode};
use crate::lifecycle::AppActivity;
use crate::session_manager::{SessionKind, SshConnectionEvent, SshSessionManager};

const COMMAND_QUEUE_CAPACITY: usize = 128;
const OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
const OUTPUT_BATCH_MAX_DELAY: Duration = Duration::from_millis(8);
const OUTPUT_MAX_IN_FLIGHT_BATCHES: usize = 8;

#[derive(Clone, Default)]
pub(crate) struct TerminalSessionManager {
    sessions: Arc<Mutex<HashMap<String, mpsc::Sender<SessionCommand>>>>,
    activity: AppActivity,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize(TerminalSize),
    AcknowledgeOutput(u64),
    Close(Option<oneshot::Sender<()>>),
}

struct TerminalOutputFlow {
    pending: Vec<u8>,
    pending_since: Option<Instant>,
    in_flight: VecDeque<u64>,
    next_sequence: u64,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeHostRequest {
    host: String,
    port: u16,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartShellRequest {
    attempt_id: String,
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

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartShellResponse {
    session_id: String,
    host_key: HostKeyInfo,
}

#[derive(Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TerminalEvent {
    Exited {
        code: Option<u32>,
        signal: Option<String>,
    },
    Error {
        code: CommandErrorCode,
        message: String,
    },
}

pub(crate) struct TerminalOutput(Vec<u8>);

impl IpcResponse for TerminalOutput {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn probe_ssh_host(request: ProbeHostRequest) -> Result<HostKeyInfo, CommandError> {
    let endpoint = SshEndpoint::new(request.host, request.port)?;
    Ok(probe_host_key(&endpoint).await?)
}

#[tauri::command]
pub(crate) async fn start_password_shell(
    window: WebviewWindow,
    manager: State<'_, TerminalSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    request: StartShellRequest,
    on_state: Channel<SshConnectionEvent>,
    on_event: Channel<TerminalEvent>,
    on_output: Channel<TerminalOutput>,
) -> Result<StartShellResponse, CommandError> {
    let owner = window.label().to_owned();
    let endpoint = SshEndpoint::new(request.host.clone(), request.port)?;
    let size = TerminalSize::with_pixels(
        request.columns,
        request.rows,
        request.pixel_width,
        request.pixel_height,
    )?;
    let cancellation =
        session_manager.begin_attempt(&owner, &request.attempt_id, SessionKind::Terminal)?;
    let _ = on_state.send(SshConnectionEvent {
        attempt_id: request.attempt_id.clone(),
        stage: SshConnectionStage::Created,
    });
    let session = authenticate_password_with_progress(
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
    let session = match session {
        Ok(session) => session,
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
    let host_key = session.host_key().clone();
    let opening = session_manager.transition_attempt(
        &owner,
        &request.attempt_id,
        SshConnectionStage::OpeningChannel,
    )?;
    let _ = on_state.send(opening);
    let shell = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(SshError::ConnectionCancelled),
        result = session.open_shell(size) => result,
    };
    let shell = match shell {
        Ok(shell) => shell,
        Err(error) => {
            let _ = session.disconnect().await;
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
    let (session_id, connected) =
        match session_manager.complete_attempt(&owner, &request.attempt_id) {
            Ok(result) => result,
            Err(error) => {
                let _ = shell.close().await;
                let _ = session.disconnect().await;
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
    let (command_tx, command_rx) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    let activity_guard = manager.activity.track_session();

    manager
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), command_tx);

    let task_manager = manager.inner().clone();
    let task_session_manager = session_manager.inner().clone();
    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let _activity_guard = activity_guard;
        run_session(
            task_manager,
            task_session_manager,
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
#[specta::specta]
pub(crate) async fn write_terminal(
    window: WebviewWindow,
    manager: State<'_, TerminalSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    data: String,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Terminal)?;
    manager
        .send(&session_id, SessionCommand::Write(data.into_bytes()))
        .await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn resize_terminal(
    window: WebviewWindow,
    manager: State<'_, TerminalSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    columns: u32,
    rows: u32,
    pixel_width: u32,
    pixel_height: u32,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Terminal)?;
    let size = TerminalSize::with_pixels(columns, rows, pixel_width, pixel_height)?;
    manager
        .send(&session_id, SessionCommand::Resize(size))
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn acknowledge_terminal_output(
    window: WebviewWindow,
    manager: State<'_, TerminalSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
    sequence: u64,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Terminal)?;
    manager
        .send(&session_id, SessionCommand::AcknowledgeOutput(sequence))
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn close_terminal_session(
    window: WebviewWindow,
    manager: State<'_, TerminalSessionManager>,
    session_manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<(), CommandError> {
    session_manager.authorize_session(window.label(), &session_id, SessionKind::Terminal)?;
    let result = manager.close(&session_id).await;
    session_manager.remove_session(&session_id, SessionKind::Terminal);
    result
}

impl TerminalSessionManager {
    pub(crate) fn with_activity(activity: AppActivity) -> Self {
        Self {
            sessions: Arc::default(),
            activity,
        }
    }

    pub(crate) async fn close_all(&self) {
        let senders = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>();

        let mut completions = Vec::with_capacity(senders.len());
        for sender in senders {
            let (complete, completed) = oneshot::channel();
            if sender
                .try_send(SessionCommand::Close(Some(complete)))
                .is_ok()
            {
                completions.push(completed);
            }
        }

        for completed in completions {
            let _ = completed.await;
        }
    }

    async fn close(&self, session_id: &str) -> Result<(), CommandError> {
        let sender = self
            .sessions
            .lock()
            .await
            .remove(session_id)
            .ok_or_else(|| CommandError::session_not_found("terminal"))?;
        let (complete, completed) = oneshot::channel();
        sender
            .send(SessionCommand::Close(Some(complete)))
            .await
            .map_err(|_| CommandError::session_closed("terminal"))?;
        completed
            .await
            .map_err(|_| CommandError::session_closed("terminal"))
    }

    async fn send(&self, session_id: &str, command: SessionCommand) -> Result<(), CommandError> {
        let sender = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| CommandError::session_not_found("terminal"))?;
        sender
            .send(command)
            .await
            .map_err(|_| CommandError::session_closed("terminal"))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    manager: TerminalSessionManager,
    session_manager: SshSessionManager,
    session_id: String,
    session: ClientSession,
    mut shell: SshShell,
    mut commands: mpsc::Receiver<SessionCommand>,
    on_event: Channel<TerminalEvent>,
    on_output: Channel<TerminalOutput>,
) {
    let mut exit_code = None;
    let mut exit_signal = None;
    let mut close_completion = None;
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
                    Some(SessionCommand::Close(completion)) => {
                        close_completion = completion;
                        if let Err(error) = shell.close().await {
                            send_error(&on_event, error);
                        }
                        break;
                    }
                    None => {
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
    session_manager.remove_session(&session_id, SessionKind::Terminal);
    drop(shell);
    let _ = session.disconnect().await;
    if let Some(complete) = close_completion {
        let _ = complete.send(());
    }
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

    fn flush(&mut self, channel: &Channel<TerminalOutput>) -> tauri::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }

        let data = std::mem::replace(
            &mut self.pending,
            Vec::with_capacity(OUTPUT_BATCH_MAX_BYTES),
        );
        channel.send(TerminalOutput(data))?;
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use super::{
        SessionCommand, TerminalOutputFlow, TerminalSessionManager, OUTPUT_BATCH_MAX_BYTES,
        OUTPUT_MAX_IN_FLIGHT_BATCHES,
    };
    use crate::command_error::CommandErrorCode;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn rejects_unknown_session_handles() {
        let manager = TerminalSessionManager::default();
        let error = manager
            .send("missing", SessionCommand::Write(Vec::new()))
            .await
            .unwrap_err();

        assert_eq!(error.code, CommandErrorCode::SessionNotFound);
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

    #[tokio::test]
    async fn waits_for_session_cleanup_when_closing_all_sessions() {
        let manager = TerminalSessionManager::default();
        let (sender, mut commands) = mpsc::channel(1);
        manager
            .sessions
            .lock()
            .await
            .insert("active".to_owned(), sender);
        let worker = tokio::spawn(async move {
            let Some(SessionCommand::Close(Some(complete))) = commands.recv().await else {
                panic!("close command did not include a completion signal");
            };
            complete.send(()).unwrap();
        });

        manager.close_all().await;
        worker.await.unwrap();

        assert!(manager.sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn waits_for_session_cleanup_when_closing_one_session() {
        let manager = TerminalSessionManager::default();
        let (sender, mut commands) = mpsc::channel(1);
        manager
            .sessions
            .lock()
            .await
            .insert("active".to_owned(), sender);
        let worker = tokio::spawn(async move {
            let Some(SessionCommand::Close(Some(complete))) = commands.recv().await else {
                panic!("close command did not include a completion signal");
            };
            assert!(!complete.is_closed());
            complete.send(()).unwrap();
        });

        manager.close("active").await.unwrap();
        worker.await.unwrap();

        assert!(manager.sessions.lock().await.is_empty());
    }
}
