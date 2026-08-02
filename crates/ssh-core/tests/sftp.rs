use std::env;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bx_ssh_core::{authenticate_password, probe_host_key, SshEndpoint, SshError};
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

const DEFAULT_TEST_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_PHASE_TIMEOUT: Duration = Duration::from_secs(90);
const DATA_BLOCK_BYTES: usize = 1024 * 1024;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the isolated OpenSSH test server"]
async fn validates_sftp_directory_transfer_and_sha256() {
    let host = required_env("BX_SSH_TEST_HOST");
    let port = required_env("BX_SSH_TEST_PORT").parse().unwrap();
    let username = required_env("BX_SSH_TEST_USERNAME");
    let password = required_env("BX_SSH_TEST_PASSWORD");
    let test_bytes = env::var("BX_SSH_TEST_SFTP_BYTES")
        .map(|value| value.parse().unwrap())
        .unwrap_or(DEFAULT_TEST_BYTES);
    let phase_timeout = env::var("BX_SSH_TEST_SFTP_PHASE_TIMEOUT_SECS")
        .map(|value| Duration::from_secs(value.parse().unwrap()))
        .unwrap_or(DEFAULT_PHASE_TIMEOUT);
    let endpoint = SshEndpoint::new(host, port)
        .unwrap()
        .with_connect_timeout(Duration::from_secs(10))
        .with_operation_timeout(Duration::from_secs(30));
    let host_key = run_phase("probe_host_key", phase_timeout, probe_host_key(&endpoint))
        .await
        .unwrap();
    let ssh = run_phase(
        "authenticate_password",
        phase_timeout,
        authenticate_password(
            &endpoint,
            &username,
            &host_key.fingerprint_sha256,
            &password,
        ),
    )
    .await
    .unwrap();
    let sftp = run_phase("open_sftp", phase_timeout, ssh.open_sftp())
        .await
        .unwrap();
    let test_root = temporary_test_directory();
    fs::create_dir_all(&test_root).await.unwrap();
    let source_path = test_root.join("source.bin");
    let download_path = test_root.join("download.bin");
    let remote_name = format!(".bx-ssh-sftp-test-{}.bin", std::process::id());
    let remote_path = format!("./{remote_name}");

    let validation: Result<_, String> = async {
        run_phase(
            "create_local_test_file",
            phase_timeout,
            create_test_file(&source_path, test_bytes),
        )
        .await?;
        let initial_directory = run_phase(
            "list_initial_directory",
            phase_timeout,
            sftp.list_directory("."),
        )
        .await?;
        assert!(!initial_directory.path.is_empty());

        let upload = run_phase(
            "upload_and_verify",
            phase_timeout,
            sftp.upload_file(&source_path, &remote_path),
        )
        .await?;
        let uploaded_directory = run_phase(
            "list_uploaded_directory",
            phase_timeout,
            sftp.list_directory("."),
        )
        .await?;
        let uploaded_entry = uploaded_directory
            .entries
            .iter()
            .find(|entry| entry.name == remote_name)
            .expect("uploaded file was not returned by read_dir");
        assert_eq!(uploaded_entry.size, test_bytes);

        let download = run_phase(
            "download_and_verify",
            phase_timeout,
            sftp.download_file(&remote_path, &download_path),
        )
        .await?;
        Ok((upload, download))
    }
    .await;

    cleanup_phase(
        "remove_remote_test_file",
        phase_timeout,
        sftp.remove_file(&remote_path),
    )
    .await;
    cleanup_phase("close_sftp", phase_timeout, sftp.close()).await;
    cleanup_phase("disconnect_ssh", phase_timeout, ssh.disconnect()).await;
    cleanup_phase("remove_local_test_directory", phase_timeout, async {
        fs::remove_dir_all(&test_root).await.map_err(SshError::from)
    })
    .await;

    let (upload, download) = validation.unwrap();
    assert_eq!(upload.bytes, test_bytes);
    assert_eq!(download.bytes, test_bytes);
    assert_eq!(upload.sha256, download.sha256);
    println!(
        "BX_SFTP_RESULT bytes={} upload_bps={} download_bps={} sha256={}",
        test_bytes, upload.bytes_per_second, download.bytes_per_second, upload.sha256
    );
}

async fn run_phase<T>(
    name: &str,
    phase_timeout: Duration,
    future: impl Future<Output = Result<T, SshError>>,
) -> Result<T, String> {
    eprintln!("BX_SFTP_PHASE name={name} status=started");
    match timeout(phase_timeout, future).await {
        Ok(Ok(value)) => {
            eprintln!("BX_SFTP_PHASE name={name} status=completed");
            Ok(value)
        }
        Ok(Err(error)) => Err(format!("SFTP phase {name} failed: {error}")),
        Err(_) => Err(format!(
            "SFTP phase {name} timed out after {} seconds",
            phase_timeout.as_secs()
        )),
    }
}

async fn cleanup_phase(
    name: &str,
    phase_timeout: Duration,
    future: impl Future<Output = Result<(), SshError>>,
) {
    eprintln!("BX_SFTP_PHASE name={name} status=started");
    match timeout(phase_timeout, future).await {
        Ok(Ok(())) => eprintln!("BX_SFTP_PHASE name={name} status=completed"),
        Ok(Err(error)) => eprintln!("BX_SFTP_PHASE name={name} status=failed error={error}"),
        Err(_) => eprintln!("BX_SFTP_PHASE name={name} status=timed_out"),
    }
}

async fn create_test_file(path: &Path, bytes: u64) -> Result<(), SshError> {
    let mut file = File::create(path).await?;
    let block = (0..DATA_BLOCK_BYTES)
        .map(|index| ((index * 31 + 17) % 251) as u8)
        .collect::<Vec<_>>();
    let mut remaining = bytes;

    while remaining > 0 {
        let write_bytes = remaining.min(block.len() as u64) as usize;
        file.write_all(&block[..write_bytes]).await?;
        remaining -= write_bytes as u64;
    }
    file.flush().await?;
    file.sync_all().await?;
    Ok(())
}

fn temporary_test_directory() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!("bx-ssh-sftp-test-{}-{unique}", std::process::id()))
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("missing required environment variable {name}"))
}
