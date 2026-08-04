use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bx_contracts::SshConnectionStage;
use bx_ssh_core::{ConnectionCancellation, SshConnectionStateMachine};
use serde::Serialize;
use specta::Type;
use tauri::{State, WebviewWindow};
use uuid::{Uuid, Version};

use crate::command_error::{CommandError, CommandErrorCode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionKind {
    Terminal,
    Sftp,
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
            return Err(CommandError::new(
                CommandErrorCode::ConnectionAttemptConflict,
                "SSH connection attempt is already active",
            ));
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
        attempt.state.transition(stage).map_err(|error| {
            CommandError::new(CommandErrorCode::SessionStateInvalid, error.to_string())
                .with_stage(Some(stage))
        })?;
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
        let mut attempt = inner
            .attempts
            .remove(attempt_id)
            .expect("authorized SSH connection attempt disappeared");
        if let Err(error) = attempt.state.transition(SshConnectionStage::Connected) {
            inner.attempts.insert(attempt_id.to_owned(), attempt);
            return Err(CommandError::new(
                CommandErrorCode::SessionStateInvalid,
                error.to_string(),
            )
            .with_stage(Some(SshConnectionStage::Connected)));
        }

        let session_id = next_session_id(&inner.sessions);
        inner.sessions.insert(
            session_id.clone(),
            ManagedSession {
                owner: attempt.owner,
                kind: attempt.kind,
                state: attempt.state,
            },
        );
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
        if attempt.state.transition(stage).is_err() {
            return None;
        }
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
    use super::{SessionKind, SshSessionManager};
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
}
