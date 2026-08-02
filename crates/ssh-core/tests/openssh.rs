use std::env;
use std::path::PathBuf;
use std::time::Duration;

use bx_ssh_core::{
    authenticate_password, authenticate_private_key, probe_host_key, SshEndpoint, SshError,
};

const WRONG_FINGERPRINT: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the isolated OpenSSH test server"]
async fn validates_host_key_password_and_private_key_authentication() {
    let host = required_env("BX_SSH_TEST_HOST");
    let port = required_env("BX_SSH_TEST_PORT").parse().unwrap();
    let username = required_env("BX_SSH_TEST_USERNAME");
    let password = required_env("BX_SSH_TEST_PASSWORD");
    let private_key = PathBuf::from(required_env("BX_SSH_TEST_PRIVATE_KEY"));
    let endpoint = SshEndpoint::new(host, port)
        .unwrap()
        .with_connect_timeout(Duration::from_secs(5))
        .with_operation_timeout(Duration::from_secs(10));

    let host_key = probe_host_key(&endpoint).await.unwrap();
    assert_eq!(host_key.algorithm, "ssh-ed25519");
    assert!(host_key.fingerprint_sha256.starts_with("SHA256:"));

    let mismatch = authenticate_password(&endpoint, &username, WRONG_FINGERPRINT, &password).await;
    assert!(matches!(
        mismatch,
        Err(SshError::HostKeyMismatch { actual, .. })
            if actual == host_key.fingerprint_sha256
    ));

    let rejected = authenticate_password(
        &endpoint,
        &username,
        &host_key.fingerprint_sha256,
        "incorrect-password",
    )
    .await;
    assert!(matches!(
        rejected,
        Err(SshError::AuthenticationRejected { method: "password" })
    ));

    let password_session = authenticate_password(
        &endpoint,
        &username,
        &host_key.fingerprint_sha256,
        &password,
    )
    .await
    .unwrap();
    assert_eq!(password_session.host_key(), &host_key);
    password_session.disconnect().await.unwrap();

    let key_session = authenticate_private_key(
        &endpoint,
        &username,
        &host_key.fingerprint_sha256,
        private_key,
        None,
    )
    .await
    .unwrap();
    assert_eq!(key_session.host_key(), &host_key);
    key_session.disconnect().await.unwrap();
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("missing required environment variable {name}"))
}
