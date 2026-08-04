use bx_contracts::SshConnectionStage;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct SshConnectionStateMachine {
    current: SshConnectionStage,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("invalid SSH connection transition from {from:?} to {to:?}")]
pub struct SshStateTransitionError {
    pub from: SshConnectionStage,
    pub to: SshConnectionStage,
}

impl Default for SshConnectionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl SshConnectionStateMachine {
    pub fn new() -> Self {
        Self {
            current: SshConnectionStage::Created,
        }
    }

    pub fn current(&self) -> SshConnectionStage {
        self.current
    }

    pub fn transition(&mut self, next: SshConnectionStage) -> Result<(), SshStateTransitionError> {
        if !valid_transition(self.current, next) {
            return Err(SshStateTransitionError {
                from: self.current,
                to: next,
            });
        }
        self.current = next;
        Ok(())
    }
}

fn valid_transition(from: SshConnectionStage, to: SshConnectionStage) -> bool {
    use SshConnectionStage::{
        Authenticating, Cancelled, Closed, Closing, Connected, ConnectingTcp, Created, Failed,
        Handshaking, OpeningChannel, ResolvingDns,
    };

    matches!(
        (from, to),
        (Created, ResolvingDns)
            | (ResolvingDns, ConnectingTcp)
            | (ConnectingTcp, Handshaking)
            | (Handshaking, Authenticating)
            | (Authenticating, OpeningChannel)
            | (OpeningChannel, Connected)
            | (Connected, Closing)
            | (Closing, Closed)
            | (Connected, Closed)
    ) || (!matches!(from, Connected | Closing | Closed | Cancelled | Failed)
        && matches!(to, Cancelled | Failed))
}

#[cfg(test)]
mod tests {
    use super::SshConnectionStateMachine;
    use bx_contracts::SshConnectionStage;

    #[test]
    fn accepts_only_forward_connection_transitions() {
        let mut state = SshConnectionStateMachine::new();
        for stage in [
            SshConnectionStage::ResolvingDns,
            SshConnectionStage::ConnectingTcp,
            SshConnectionStage::Handshaking,
            SshConnectionStage::Authenticating,
            SshConnectionStage::OpeningChannel,
            SshConnectionStage::Connected,
            SshConnectionStage::Closing,
            SshConnectionStage::Closed,
        ] {
            state.transition(stage).unwrap();
        }

        assert!(state.transition(SshConnectionStage::Connected).is_err());
    }

    #[test]
    fn allows_cancellation_only_before_a_connection_is_active() {
        let mut pending = SshConnectionStateMachine::new();
        pending
            .transition(SshConnectionStage::ResolvingDns)
            .unwrap();
        pending.transition(SshConnectionStage::Cancelled).unwrap();
        assert!(pending
            .transition(SshConnectionStage::ConnectingTcp)
            .is_err());

        let mut active = SshConnectionStateMachine::new();
        for stage in [
            SshConnectionStage::ResolvingDns,
            SshConnectionStage::ConnectingTcp,
            SshConnectionStage::Handshaking,
            SshConnectionStage::Authenticating,
            SshConnectionStage::OpeningChannel,
            SshConnectionStage::Connected,
        ] {
            active.transition(stage).unwrap();
        }
        assert!(active.transition(SshConnectionStage::Cancelled).is_err());
    }
}
