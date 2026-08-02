use std::env;
use std::path::PathBuf;
use std::time::Duration;

use bx_ssh_core::{
    authenticate_password, authenticate_private_key, probe_host_key, ShellEvent, SshEndpoint,
    SshError, TerminalSize,
};

const WRONG_FINGERPRINT: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LARGE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the isolated OpenSSH test server"]
async fn validates_host_key_authentication_and_interactive_shell() {
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

    let mut shell = password_session
        .open_shell(TerminalSize::new(80, 24).unwrap())
        .await
        .unwrap();
    shell
        .resize(TerminalSize::new(100, 31).unwrap())
        .await
        .unwrap();
    shell.write("stty -echo; printf '\\001'\n").await.unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match shell.next_event().await.unwrap() {
                ShellEvent::Output(data) | ShellEvent::ExtendedOutput { data, .. }
                    if data.contains(&1) =>
                {
                    break;
                }
                ShellEvent::Output(_) | ShellEvent::ExtendedOutput { .. } | ShellEvent::Eof => {}
                ShellEvent::ExitStatus(status) => {
                    panic!("shell exited before the test command with status {status}")
                }
                ShellEvent::ExitSignal { signal, .. } => {
                    panic!("shell exited before the test command on signal {signal}")
                }
                ShellEvent::Closed => panic!("shell closed before the test command"),
            }
        }
    })
    .await
    .expect("timed out while disabling terminal echo");

    shell
        .write(
            format!(
                "printf '__BX_SHELL_READY__\\n'; printf '__BX_TERM__%s\\n' \"$TERM\"; stty size; printf '中文宽字符\\n'; head -c {LARGE_OUTPUT_BYTES} /dev/zero | tr '\\0' 'x'; printf '\\n__BX_LARGE_OUTPUT_DONE__\\n'; exit 23\n"
            ),
        )
        .await
        .unwrap();

    let (output, exit_status) = tokio::time::timeout(Duration::from_secs(30), async {
        let mut output = Vec::new();
        let mut exit_status = None;
        loop {
            match shell.next_event().await.unwrap() {
                ShellEvent::Output(data) | ShellEvent::ExtendedOutput { data, .. } => {
                    output.extend(data);
                }
                ShellEvent::ExitStatus(status) => exit_status = Some(status),
                ShellEvent::Closed => break (output, exit_status),
                ShellEvent::ExitSignal { signal, .. } => {
                    panic!("shell exited on signal {signal}")
                }
                ShellEvent::Eof => {}
            }
        }
    })
    .await
    .expect("timed out while waiting for the shell to exit");

    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("__BX_SHELL_READY__"));
    assert!(output.contains("__BX_TERM__xterm-256color"));
    assert!(output.contains("31 100"));
    assert!(output.contains("中文宽字符"));
    assert!(output.contains("__BX_LARGE_OUTPUT_DONE__"));
    assert!(output.len() >= LARGE_OUTPUT_BYTES);
    assert_eq!(exit_status, Some(23));
    drop(shell);
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
