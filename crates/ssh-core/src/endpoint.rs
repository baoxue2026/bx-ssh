use std::time::Duration;

use bx_contracts::ConnectionSettings;

use crate::SshError;

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEndpoint {
    host: String,
    port: u16,
    connect_timeout: Duration,
    operation_timeout: Duration,
    keep_alive_interval: Option<Duration>,
}

impl SshEndpoint {
    pub fn new(host: impl Into<String>, port: u16) -> Result<Self, SshError> {
        let host = host.into();
        let host = host.trim();
        if host.is_empty() {
            return Err(SshError::InvalidHost);
        }
        if port == 0 {
            return Err(SshError::InvalidPort);
        }

        Ok(Self {
            host: host.to_owned(),
            port,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            operation_timeout: DEFAULT_OPERATION_TIMEOUT,
            keep_alive_interval: Some(DEFAULT_OPERATION_TIMEOUT),
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn connect_timeout(&self) -> Duration {
        self.connect_timeout
    }

    pub fn operation_timeout(&self) -> Duration {
        self.operation_timeout
    }

    pub fn keep_alive_interval(&self) -> Option<Duration> {
        self.keep_alive_interval
    }

    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    pub fn with_operation_timeout(mut self, timeout: Duration) -> Self {
        self.operation_timeout = timeout;
        self
    }

    pub fn with_keep_alive_interval(mut self, interval: Option<Duration>) -> Self {
        self.keep_alive_interval = interval;
        self
    }

    pub fn with_connection_settings(self, settings: ConnectionSettings) -> Self {
        self.with_connect_timeout(Duration::from_secs(u64::from(
            settings.connect_timeout_secs,
        )))
        .with_keep_alive_interval(
            (settings.keep_alive_secs > 0)
                .then(|| Duration::from_secs(u64::from(settings.keep_alive_secs))),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::SshEndpoint;
    use crate::SshError;

    #[test]
    fn normalizes_host_and_applies_timeouts() {
        let endpoint = SshEndpoint::new("  ssh.example.com  ", 2222)
            .unwrap()
            .with_connect_timeout(Duration::from_secs(4))
            .with_operation_timeout(Duration::from_secs(8));

        assert_eq!(endpoint.host(), "ssh.example.com");
        assert_eq!(endpoint.port(), 2222);
        assert_eq!(endpoint.connect_timeout(), Duration::from_secs(4));
        assert_eq!(endpoint.operation_timeout(), Duration::from_secs(8));
        assert_eq!(
            endpoint.keep_alive_interval(),
            Some(Duration::from_secs(30))
        );
    }

    #[test]
    fn rejects_empty_host_and_zero_port() {
        assert!(matches!(
            SshEndpoint::new("  ", 22),
            Err(SshError::InvalidHost)
        ));
        assert!(matches!(
            SshEndpoint::new("localhost", 0),
            Err(SshError::InvalidPort)
        ));
    }

    #[test]
    fn applies_resolved_connection_settings_and_can_disable_keep_alive() {
        let endpoint = SshEndpoint::new("ssh.example.com", 22)
            .unwrap()
            .with_connection_settings(bx_contracts::ConnectionSettings {
                connect_timeout_secs: 12,
                keep_alive_secs: 0,
            });

        assert_eq!(endpoint.connect_timeout(), Duration::from_secs(12));
        assert_eq!(endpoint.keep_alive_interval(), None);
    }
}
