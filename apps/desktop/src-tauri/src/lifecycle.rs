use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};
use tokio::time::timeout;

use crate::command_error::CommandError;
use crate::sftp::SftpSessionManager;
use crate::terminal::TerminalSessionManager;

pub(crate) const EXIT_REQUESTED_EVENT: &str = "app-exit-requested";
const EXIT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub(crate) struct AppActivity {
    counts: Arc<ActivityCounts>,
}

#[derive(Default)]
struct ActivityCounts {
    sessions: AtomicU32,
    transfers: AtomicU32,
}

pub(crate) struct ActivityGuard {
    counts: Arc<ActivityCounts>,
    kind: ActivityKind,
}

enum ActivityKind {
    Session,
    Transfer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExitImpact {
    pub(crate) active_sessions: u32,
    pub(crate) active_transfers: u32,
}

#[derive(Default)]
pub(crate) struct ExitCoordinator {
    approved: AtomicBool,
}

impl AppActivity {
    pub(crate) fn track_session(&self) -> ActivityGuard {
        self.track(ActivityKind::Session)
    }

    pub(crate) fn track_transfer(&self) -> ActivityGuard {
        self.track(ActivityKind::Transfer)
    }

    pub(crate) fn snapshot(&self) -> ExitImpact {
        ExitImpact {
            active_sessions: self.counts.sessions.load(Ordering::Acquire),
            active_transfers: self.counts.transfers.load(Ordering::Acquire),
        }
    }

    fn track(&self, kind: ActivityKind) -> ActivityGuard {
        match kind {
            ActivityKind::Session => &self.counts.sessions,
            ActivityKind::Transfer => &self.counts.transfers,
        }
        .fetch_add(1, Ordering::AcqRel);

        ActivityGuard {
            counts: self.counts.clone(),
            kind,
        }
    }
}

impl ExitImpact {
    pub(crate) fn requires_confirmation(self) -> bool {
        self.active_sessions > 0 || self.active_transfers > 0
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let previous = match self.kind {
            ActivityKind::Session => &self.counts.sessions,
            ActivityKind::Transfer => &self.counts.transfers,
        }
        .fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "activity count underflow");
    }
}

impl ExitCoordinator {
    pub(crate) fn approve(&self) {
        self.approved.store(true, Ordering::Release);
    }

    pub(crate) fn is_approved(&self) -> bool {
        self.approved.load(Ordering::Acquire)
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn confirm_app_exit(
    app: AppHandle,
    terminal_manager: State<'_, TerminalSessionManager>,
    sftp_manager: State<'_, SftpSessionManager>,
    coordinator: State<'_, ExitCoordinator>,
) -> Result<(), CommandError> {
    let cleanup = async {
        tokio::join!(terminal_manager.close_all(), sftp_manager.close_all());
    };
    let _ = timeout(EXIT_CLEANUP_TIMEOUT, cleanup).await;
    coordinator.approve();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AppActivity, ExitImpact};

    #[test]
    fn tracks_sessions_and_transfers_until_their_guards_drop() {
        let activity = AppActivity::default();
        let first_session = activity.track_session();
        let second_session = activity.track_session();
        let transfer = activity.track_transfer();

        assert_eq!(
            activity.snapshot(),
            ExitImpact {
                active_sessions: 2,
                active_transfers: 1,
            }
        );

        drop(second_session);
        drop(transfer);
        assert_eq!(
            activity.snapshot(),
            ExitImpact {
                active_sessions: 1,
                active_transfers: 0,
            }
        );

        drop(first_session);
        assert!(!activity.snapshot().requires_confirmation());
    }
}
