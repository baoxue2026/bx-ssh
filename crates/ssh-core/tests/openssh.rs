use std::collections::BTreeMap;
use std::env;
use std::path::PathBuf;
use std::time::Duration;

use bx_ssh_core::{
    authenticate_keyboard_interactive_with_progress, authenticate_password,
    authenticate_private_key, probe_host_key, product_algorithm_policy, ConnectionCancellation,
    ShellEvent, SshEndpoint, SshError, TerminalSize,
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
    let auth_methods = env::var("BX_SSH_TEST_AUTH_METHODS")
        .unwrap_or_else(|_| "password,public-key,keyboard-interactive".to_owned());
    let shell_kind = env::var("BX_SSH_TEST_SHELL_KIND").unwrap_or_else(|_| "posix".to_owned());
    let supports_auth = |method: &str| {
        auth_methods
            .split(',')
            .map(str::trim)
            .any(|configured| configured == method)
    };
    assert!(supports_auth("password"));

    let host_key = probe_host_key(&endpoint).await.unwrap();
    let expected_algorithm = env::var("BX_SSH_TEST_EXPECTED_HOST_KEY_ALGORITHM")
        .unwrap_or_else(|_| "ssh-ed25519".to_owned());
    assert_eq!(host_key.algorithm, expected_algorithm);
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
    assert!(product_algorithm_policy().allows(password_session.negotiated_algorithms()));

    let mut shell = password_session
        .open_shell_with_environment(
            TerminalSize::new(80, 24).unwrap(),
            &BTreeMap::from([(String::from("BX_SSH_TEST_ENV"), String::from("enabled"))]),
        )
        .await
        .unwrap();
    shell
        .resize(TerminalSize::new(100, 31).unwrap())
        .await
        .unwrap();
    if shell_kind == "windows-cmd" {
        shell
            .write("@echo off\r\necho __BX_SHELL_READY__\r\nexit 23\r\n")
            .await
            .unwrap();
    } else {
        shell.write("stty -echo; printf '\\001'\n").await.unwrap();

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match shell.next_event().await.unwrap() {
                    ShellEvent::Output(data) | ShellEvent::ExtendedOutput { data, .. }
                        if data.contains(&1) =>
                    {
                        break;
                    }
                    ShellEvent::Output(_) | ShellEvent::ExtendedOutput { .. } | ShellEvent::Eof => {
                    }
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
    }

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
    if shell_kind != "windows-cmd" {
        assert!(output.contains("__BX_TERM__xterm-256color"));
        assert!(output.contains("31 100"));
        assert!(output.contains("中文宽字符"));
        assert!(output.contains("__BX_LARGE_OUTPUT_DONE__"));
        assert!(output.len() >= LARGE_OUTPUT_BYTES);
    }
    // Windows OpenSSH's PTY bridge reports a normalized zero status even
    // when cmd.exe exits with an explicit non-zero code. Keep the assertion
    // strict for POSIX servers while validating the observed Windows value.
    let expected_exit_status = env::var("BX_SSH_TEST_EXPECTED_EXIT_STATUS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(23);
    assert_eq!(exit_status, Some(expected_exit_status));
    drop(shell);
    password_session.disconnect().await.unwrap();

    if supports_auth("keyboard-interactive") {
        let keyboard_password = password.clone();
        let keyboard_session = authenticate_keyboard_interactive_with_progress(
            &endpoint,
            &username,
            &host_key.fingerprint_sha256,
            &ConnectionCancellation::default(),
            move |prompt| {
                let password = keyboard_password.clone();
                async move {
                    assert!(!prompt.prompts.is_empty());
                    Ok(prompt.prompts.iter().map(|_| password.clone()).collect())
                }
            },
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(keyboard_session.host_key(), &host_key);
        keyboard_session.disconnect().await.unwrap();
    }

    if supports_auth("public-key") {
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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the isolated OpenSSH test server"]
async fn validates_ten_concurrent_sessions() {
    if !env::var("BX_SSH_TEST_TEN_SESSIONS")
        .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
    {
        return;
    }
    let host = required_env("BX_SSH_TEST_HOST");
    let port = required_env("BX_SSH_TEST_PORT").parse().unwrap();
    let username = required_env("BX_SSH_TEST_USERNAME");
    let password = required_env("BX_SSH_TEST_PASSWORD");
    let endpoint = SshEndpoint::new(host, port)
        .unwrap()
        .with_connect_timeout(Duration::from_secs(5))
        .with_operation_timeout(Duration::from_secs(30));
    let host_key = probe_host_key(&endpoint).await.unwrap();
    let started_at = std::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..10 {
        let endpoint = endpoint.clone();
        let username = username.clone();
        let password = password.clone();
        let fingerprint = host_key.fingerprint_sha256.clone();
        tasks.spawn(async move {
            let session = authenticate_password(&endpoint, &username, &fingerprint, &password)
                .await
                .unwrap();
            session.disconnect().await.unwrap();
        });
    }
    let mut completed = 0_u32;
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
        completed += 1;
    }
    assert_eq!(completed, 10);
    println!(
        "BX_SESSION_RESULT sessions={} elapsed_ms={}",
        completed,
        started_at.elapsed().as_millis()
    );
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("missing required environment variable {name}"))
}
