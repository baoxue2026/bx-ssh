use std::time::Duration;

use crate::SshError;

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEndpoint {
    host: String,
    port: u16,
    connect_timeout: Duration,
    operation_timeout: Duration,
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

    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    pub fn with_operation_timeout(mut self, timeout: Duration) -> Self {
        self.operation_timeout = timeout;
        self
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
}
