use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bx_contracts::{LogLevel, SshConnectionStage};
use bx_ssh_core::{ConnectionCancellation, SshConnectionStateMachine};
use serde::Serialize;
use specta::Type;
use tauri::{State, WebviewWindow};
use uuid::{Uuid, Version};

use crate::command_error::{CommandError, CommandErrorCode};
use crate::logging::{self, LogFields};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionKind {
    Terminal,
    Sftp,
}

impl SessionKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Sftp => "sftp",
        }
    }
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnectionEvent {
    pub(crate) attempt_id: String,
    pub(crate) stage: SshConnectionStage,
}

#[derive(Clone, Default)]
pub(crate) struct SshSessionManager {
    inner: Arc<Mutex<ManagerState>>,
}

#[derive(Default)]
struct ManagerState {
    attempts: HashMap<String, ConnectionAttempt>,
    sessions: HashMap<String, ManagedSession>,
}

struct ConnectionAttempt {
    owner: String,
    kind: SessionKind,
    state: SshConnectionStateMachine,
    cancellation: ConnectionCancellation,
}

struct ManagedSession {
    owner: String,
    kind: SessionKind,
    state: SshConnectionStateMachine,
}

impl SshSessionManager {
    pub(crate) fn begin_attempt(
        &self,
        owner: &str,
        attempt_id: &str,
        kind: SessionKind,
    ) -> Result<ConnectionCancellation, CommandError> {
        validate_attempt_id(attempt_id)?;
        let mut inner = self.inner.lock().expect("SSH session manager poisoned");
        if inner.attempts.contains_key(attempt_id) {
            let error = CommandError::new(
                CommandErrorCode::ConnectionAttemptConflict,
                "SSH connection attempt is already active",
            );
            logging::connection_error(kind, attempt_id, &error);
            return Err(error);
        }

        let cancellation = ConnectionCancellation::default();
        inner.attempts.insert(
            attempt_id.to_owned(),
            ConnectionAttempt {
                owner: owner.to_owned(),
                kind,
                state: SshConnectionStateMachine::new(),
                cancellation: cancellation.clone(),
            },
        );
        log_connection_stage(kind, attempt_id, SshConnectionStage::Created);
        Ok(cancellation)
    }

    pub(crate) fn transition_attempt(
        &self,
        owner: &str,
        attempt_id: &str,
        stage: SshConnectionStage,
    ) -> Result<SshConnectionEvent, CommandError> {
        let mut inner = self.inner.lock().expect("SSH session manager poisoned");
        let attempt = inner
            .attempts
            .get_mut(attempt_id)
            .filter(|attempt| attempt.owner == owner)
            .ok_or_else(|| CommandError::session_not_found("SSH connection attempt"))?;
        if let Err(error) = attempt.state.transition(stage) {
            let error = CommandError::new(CommandErrorCode::SessionStateInvalid, error.to_string())
                .with_stage(Some(stage));
            logging::connection_error(attempt.kind, attempt_id, &error);
            return Err(error);
        }
        log_connection_stage(attempt.kind, attempt_id, stage);
        Ok(SshConnectionEvent {
            attempt_id: attempt_id.to_owned(),
            stage,
        })
    }

    pub(crate) fn complete_attempt(
        &self,
        owner: &str,
        attempt_id: &str,
    ) -> Result<(String, SshConnectionEvent), CommandError> {
        let mut inner = self.inner.lock().expect("SSH session manager poisoned");
        let authorized = inner
            .attempts
            .get(attempt_id)
            .is_some_and(|attempt| attempt.owner == owner);
        if !authorized {
            return Err(CommandError::session_not_found("SSH connection attempt"));
        }
        if inner
            .attempts
            .get(attempt_id)
            .is_some_and(|attempt| attempt.cancellation.is_cancelled())
        {
            return Err(CommandError::new(
                CommandErrorCode::ConnectionCancelled,
                "SSH connection attempt was cancelled",
            )
            .with_stage(Some(SshConnectionStage::Cancelled)));
        }
        let mut attempt = inner
            .attempts
            .remove(attempt_id)
            .expect("authorized SSH connection attempt disappeared");
        if let Err(error) = attempt.state.transition(SshConnectionStage::Connected) {
            let kind = attempt.kind;
            inner.attempts.insert(attempt_id.to_owned(), attempt);
            let error = CommandError::new(CommandErrorCode::SessionStateInvalid, error.to_string())
                .with_stage(Some(SshConnectionStage::Connected));
            logging::connection_error(kind, attempt_id, &error);
            return Err(error);
        }

        let session_id = next_session_id(&inner.sessions);
        let kind = attempt.kind;
        inner.sessions.insert(
            session_id.clone(),
            ManagedSession {
                owner: attempt.owner,
                kind: attempt.kind,
                state: attempt.state,
            },
        );
        log_connection_stage(kind, attempt_id, SshConnectionStage::Connected);
        Ok((
            session_id,
            SshConnectionEvent {
                attempt_id: attempt_id.to_owned(),
                stage: SshConnectionStage::Connected,
            },
        ))
    }

    pub(crate) fn finish_attempt(
        &self,
        owner: &str,
        attempt_id: &str,
        stage: SshConnectionStage,
    ) -> Option<SshConnectionEvent> {
        let mut inner = self.inner.lock().expect("SSH session manager poisoned");
        let mut attempt = inner.attempts.remove(attempt_id)?;
        if attempt.owner != owner {
            inner.attempts.insert(attempt_id.to_owned(), attempt);
            return None;
        }
        let stage = if attempt.cancellation.is_cancelled() {
            SshConnectionStage::Cancelled
        } else {
            stage
        };
        if attempt.state.transition(stage).is_err() {
            return None;
        }
        log_connection_stage(attempt.kind, attempt_id, stage);
        Some(SshConnectionEvent {
            attempt_id: attempt_id.to_owned(),
            stage,
        })
    }

    pub(crate) fn cancel_attempt(&self, owner: &str, attempt_id: &str) -> bool {
        let inner = self.inner.lock().expect("SSH session manager poisoned");
        let Some(attempt) = inner
            .attempts
            .get(attempt_id)
            .filter(|attempt| attempt.owner == owner)
        else {
            return false;
        };
        attempt.cancellation.cancel();
        true
    }

    pub(crate) fn authorize_session(
        &self,
        owner: &str,
        session_id: &str,
        kind: SessionKind,
    ) -> Result<(), CommandError> {
        let inner = self.inner.lock().expect("SSH session manager poisoned");
        let authorized = inner.sessions.get(session_id).is_some_and(|session| {
            session.owner == owner
                && session.kind == kind
                && session.state.current() == SshConnectionStage::Connected
        });
        if authorized {
            Ok(())
        } else {
            Err(CommandError::session_not_found(match kind {
                SessionKind::Terminal => "terminal",
                SessionKind::Sftp => "SFTP",
            }))
        }
    }

    pub(crate) fn remove_session(&self, session_id: &str, kind: SessionKind) {
        let mut inner = self.inner.lock().expect("SSH session manager poisoned");
        if inner
            .sessions
            .get(session_id)
            .is_some_and(|session| session.kind == kind)
        {
            inner.sessions.remove(session_id);
            logging::event(
                LogLevel::Info,
                "ssh_session_closed",
                LogFields {
                    session_type: Some(kind.as_str()),
                    session_id: Some(session_id),
                    connection_stage: Some(SshConnectionStage::Closed),
                    ..LogFields::default()
                },
            );
        }
    }

    pub(crate) fn clear(&self) {
        let mut inner = self.inner.lock().expect("SSH session manager poisoned");
        for attempt in inner.attempts.values() {
            attempt.cancellation.cancel();
        }
        inner.attempts.clear();
        inner.sessions.clear();
    }
}

fn log_connection_stage(kind: SessionKind, attempt_id: &str, stage: SshConnectionStage) {
    logging::event(
        LogLevel::Info,
        "ssh_connection_stage_changed",
        LogFields {
            session_type: Some(kind.as_str()),
            attempt_id: Some(attempt_id),
            connection_stage: Some(stage),
            ..LogFields::default()
        },
    );
}

#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_ssh_connection(
    window: WebviewWindow,
    manager: State<'_, SshSessionManager>,
    attempt_id: String,
) -> Result<bool, CommandError> {
    validate_attempt_id(&attempt_id)?;
    Ok(manager.cancel_attempt(window.label(), &attempt_id))
}

fn validate_attempt_id(attempt_id: &str) -> Result<(), CommandError> {
    let valid = Uuid::parse_str(attempt_id)
        .ok()
        .is_some_and(|id| id.get_version() == Some(Version::Random));
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            CommandErrorCode::InvalidConnectionAttempt,
            "SSH connection attempt ID must be a random UUID",
        ))
    }
}

fn next_session_id(sessions: &HashMap<String, ManagedSession>) -> String {
    loop {
        let id = Uuid::new_v4().to_string();
        if !sessions.contains_key(&id) {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::{SessionKind, SshSessionManager};
    use crate::command_error::CommandErrorCode;
    use bx_contracts::SshConnectionStage;

    const ATTEMPT_ID: &str = "4f715a34-6a86-4e45-bc2a-8ae680acb614";

    #[test]
    fn enforces_forward_attempt_states_and_random_handles() {
        let manager = SshSessionManager::default();
        manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Terminal)
            .unwrap();
        for stage in [
            SshConnectionStage::ResolvingDns,
            SshConnectionStage::ConnectingTcp,
            SshConnectionStage::Handshaking,
            SshConnectionStage::Authenticating,
            SshConnectionStage::OpeningChannel,
        ] {
            manager
                .transition_attempt("main", ATTEMPT_ID, stage)
                .unwrap();
        }
        let (session_id, event) = manager.complete_attempt("main", ATTEMPT_ID).unwrap();

        assert_eq!(event.stage, SshConnectionStage::Connected);
        let parsed = uuid::Uuid::parse_str(&session_id).unwrap();
        assert_eq!(parsed.get_version(), Some(uuid::Version::Random));
        manager
            .authorize_session("main", &session_id, SessionKind::Terminal)
            .unwrap();
    }

    #[test]
    fn rejects_cross_window_and_cross_kind_session_access() {
        let manager = SshSessionManager::default();
        manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Terminal)
            .unwrap();
        for stage in [
            SshConnectionStage::ResolvingDns,
            SshConnectionStage::ConnectingTcp,
            SshConnectionStage::Handshaking,
            SshConnectionStage::Authenticating,
            SshConnectionStage::OpeningChannel,
        ] {
            manager
                .transition_attempt("main", ATTEMPT_ID, stage)
                .unwrap();
        }
        let (session_id, _) = manager.complete_attempt("main", ATTEMPT_ID).unwrap();

        assert!(manager
            .authorize_session("other", &session_id, SessionKind::Terminal)
            .is_err());
        assert!(manager
            .authorize_session("main", &session_id, SessionKind::Sftp)
            .is_err());
    }

    #[test]
    fn cancellation_is_limited_to_the_attempt_owner() {
        let manager = SshSessionManager::default();
        let cancellation = manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Sftp)
            .unwrap();

        assert!(!manager.cancel_attempt("other", ATTEMPT_ID));
        assert!(!cancellation.is_cancelled());
        assert!(manager.cancel_attempt("main", ATTEMPT_ID));
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn rejects_predictable_attempt_identifiers() {
        let manager = SshSessionManager::default();
        assert!(manager
            .begin_attempt("main", "connection-1", SessionKind::Terminal)
            .is_err());
    }

    #[test]
    fn retains_attempt_when_completion_transition_is_invalid() {
        let manager = SshSessionManager::default();
        manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Terminal)
            .unwrap();

        assert!(manager.complete_attempt("main", ATTEMPT_ID).is_err());
        manager
            .transition_attempt("main", ATTEMPT_ID, SshConnectionStage::ResolvingDns)
            .unwrap();
    }

    #[test]
    fn allows_only_one_concurrent_attempt_for_a_shared_identifier() {
        const WORKERS: usize = 8;
        let manager = SshSessionManager::default();
        let barrier = Arc::new(Barrier::new(WORKERS));
        let handles = (0..WORKERS)
            .map(|index| {
                let manager = manager.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    manager.begin_attempt(
                        if index == 0 { "owner-a" } else { "owner-b" },
                        ATTEMPT_ID,
                        SessionKind::Terminal,
                    )
                })
            })
            .collect::<Vec<_>>();

        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("attempt worker must not panic"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    result.as_ref().is_err_and(|error| {
                        error.code == CommandErrorCode::ConnectionAttemptConflict
                    })
                })
                .count(),
            WORKERS - 1
        );
    }

    #[test]
    fn cancellation_wins_over_completion_and_finishes_as_cancelled() {
        let manager = SshSessionManager::default();
        let cancellation = manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Terminal)
            .unwrap();
        for stage in [
            SshConnectionStage::ResolvingDns,
            SshConnectionStage::ConnectingTcp,
            SshConnectionStage::Handshaking,
            SshConnectionStage::Authenticating,
            SshConnectionStage::OpeningChannel,
        ] {
            manager
                .transition_attempt("main", ATTEMPT_ID, stage)
                .unwrap();
        }

        cancellation.cancel();
        let error = manager
            .complete_attempt("main", ATTEMPT_ID)
            .expect_err("cancelled attempts must not become connected");
        assert_eq!(error.code, CommandErrorCode::ConnectionCancelled);
        assert_eq!(error.stage, Some(SshConnectionStage::Cancelled));

        let event = manager
            .finish_attempt("main", ATTEMPT_ID, SshConnectionStage::Failed)
            .expect("cancelled attempt must emit a terminal state");
        assert_eq!(event.stage, SshConnectionStage::Cancelled);
    }

    #[test]
    fn clear_cancels_pending_attempts_and_invalidates_sessions() {
        const CONNECTED_ATTEMPT_ID: &str = "83f6f4e4-f0e7-48a7-8c3e-4e4e7a3c4a52";
        let manager = SshSessionManager::default();
        let pending = manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Terminal)
            .unwrap();
        manager
            .begin_attempt("main", CONNECTED_ATTEMPT_ID, SessionKind::Sftp)
            .unwrap();
        for stage in [
            SshConnectionStage::ResolvingDns,
            SshConnectionStage::ConnectingTcp,
            SshConnectionStage::Handshaking,
            SshConnectionStage::Authenticating,
            SshConnectionStage::OpeningChannel,
        ] {
            manager
                .transition_attempt("main", CONNECTED_ATTEMPT_ID, stage)
                .unwrap();
        }
        let (session_id, _) = manager
            .complete_attempt("main", CONNECTED_ATTEMPT_ID)
            .unwrap();

        manager.clear();

        assert!(pending.is_cancelled());
        assert!(manager
            .authorize_session("main", &session_id, SessionKind::Sftp)
            .is_err());
        assert!(manager
            .begin_attempt("main", ATTEMPT_ID, SessionKind::Terminal)
            .is_ok());
    }
}
