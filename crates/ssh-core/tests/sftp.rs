use std::env;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bx_contracts::SftpConflictAction;
use bx_ssh_core::{
    authenticate_password, probe_host_key, ConnectionCancellation, SshEndpoint, SshError,
};
use russh_sftp::{client::error::Error as SftpError, protocol::StatusCode};
use sha2::{Digest, Sha256};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

const DEFAULT_TEST_BYTES: u64 = 8 * 1024 * 1024;
const ONE_GIB_BYTES: u64 = 1024 * 1024 * 1024;
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
    let require_one_gib = env::var("BX_SSH_TEST_SFTP_REQUIRE_ONE_GIB")
        .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    let windows_server = env::var("BX_SSH_TEST_WINDOWS_SERVER")
        .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    if require_one_gib {
        assert!(
            !cfg!(debug_assertions),
            "the 1 GiB performance gate requires cargo test --release"
        );
        assert_eq!(
            test_bytes, ONE_GIB_BYTES,
            "BX_SSH_TEST_SFTP_REQUIRE_ONE_GIB requires BX_SSH_TEST_SFTP_BYTES=1073741824"
        );
    }
    let minimum_speed_percent =
        optional_env_u64("BX_SSH_TEST_SFTP_MIN_SPEED_PERCENT").unwrap_or(80);
    assert!(
        (1..=100).contains(&minimum_speed_percent),
        "BX_SSH_TEST_SFTP_MIN_SPEED_PERCENT must be between 1 and 100"
    );
    if require_one_gib {
        assert_eq!(
            minimum_speed_percent, 80,
            "the formal performance gate is 80%"
        );
    }
    let baseline_speed = if require_one_gib {
        None
    } else {
        optional_env_u64("BX_SSH_TEST_SFTP_BASELINE_BPS")
    };
    let baseline_upload_speed =
        optional_env_u64("BX_SSH_TEST_SFTP_BASELINE_UPLOAD_BPS").or(baseline_speed);
    let baseline_download_speed =
        optional_env_u64("BX_SSH_TEST_SFTP_BASELINE_DOWNLOAD_BPS").or(baseline_speed);
    for (name, baseline) in [
        (
            "BX_SSH_TEST_SFTP_BASELINE_UPLOAD_BPS",
            baseline_upload_speed,
        ),
        (
            "BX_SSH_TEST_SFTP_BASELINE_DOWNLOAD_BPS",
            baseline_download_speed,
        ),
    ] {
        if let Some(baseline) = baseline {
            assert!(baseline > 0, "{name} must be greater than zero");
        }
    }
    if require_one_gib && (baseline_upload_speed.is_none() || baseline_download_speed.is_none()) {
        panic!("BX_SSH_TEST_SFTP_REQUIRE_ONE_GIB requires per-direction OpenSSH SFTP baselines");
    }
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
    let remote_home = run_phase("resolve_remote_home", phase_timeout, sftp.canonicalize("."))
        .await
        .unwrap();
    let test_root = temporary_test_directory();
    fs::create_dir_all(&test_root).await.unwrap();
    let source_path = test_root.join("source.bin");
    let download_path = test_root.join("download.bin");
    let remote_name = format!(".bx-ssh-sftp-test-{}.bin", std::process::id());
    let remote_path = if remote_home == "/" {
        format!("/{remote_name}")
    } else {
        format!("{}/{remote_name}", remote_home.trim_end_matches('/'))
    };
    let source_directory = test_root.join("source-directory");
    let cancelled_download_path = test_root.join("cancelled-download.bin");
    let cancelled_upload_path = format!("{remote_path}.cancelled");
    let source_deep_directory = source_directory.join("deep").join("a").join("b");
    let source_empty_directory = source_directory.join("empty");
    let source_directory_file = source_deep_directory.join("source.bin");
    let download_directory = test_root.join("download-directory");
    let remote_directory_name = format!(".bx-ssh-sftp-test-{}.dir", std::process::id());
    let remote_directory = if remote_home == "/" {
        format!("/{remote_directory_name}")
    } else {
        format!(
            "{}/{remote_directory_name}",
            remote_home.trim_end_matches('/')
        )
    };
    let remote_operations_name = format!(".bx-ssh-sftp-test-{}.ops", std::process::id());
    let remote_operations = if remote_home == "/" {
        format!("/{remote_operations_name}")
    } else {
        format!(
            "{}/{remote_operations_name}",
            remote_home.trim_end_matches('/')
        )
    };

    let validation: Result<_, String> = async {
        run_phase(
            "create_local_test_file",
            phase_timeout,
            create_test_file(&source_path, test_bytes),
        )
        .await?;
        fs::create_dir_all(&source_deep_directory)
            .await
            .map_err(|error| error.to_string())?;
        fs::create_dir(&source_empty_directory)
            .await
            .map_err(|error| error.to_string())?;
        fs::copy(&source_path, &source_directory_file)
            .await
            .map_err(|error| error.to_string())?;
        let initial_directory = run_phase(
            "list_initial_directory",
            phase_timeout,
            sftp.list_directory("."),
        )
        .await?;
        assert!(!initial_directory.path.is_empty());

        let upload_started = Instant::now();
        let upload = run_phase(
            "upload_and_verify",
            phase_timeout,
            sftp.upload_file(&source_path, &remote_path),
        )
        .await?;
        let upload_total_ms = upload_started.elapsed().as_millis();
        run_phase("cancel_upload_without_publishing", phase_timeout, async {
            let cancellation = ConnectionCancellation::default();
            let result = sftp.upload_file_with_progress(
                &source_path, &cancelled_upload_path, Some(&cancellation), SftpConflictAction::Ask,
                &mut |_| cancellation.cancel(),
            ).await;
            assert!(matches!(result, Err(SshError::TransferCancelled)));
            assert!(matches!(sftp.stat_path(&cancelled_upload_path).await,
                Err(SshError::Sftp(SftpError::Status(status))) if status.status_code == StatusCode::NoSuchFile));
            Ok(())
        }).await?;
        run_phase("cancel_download_without_publishing", phase_timeout, async {
            let cancellation = ConnectionCancellation::default();
            let result = sftp.download_file_with_progress(
                &remote_path, &cancelled_download_path, Some(&cancellation), SftpConflictAction::Ask,
                &mut |_| cancellation.cancel(),
            ).await;
            assert!(matches!(result, Err(SshError::TransferCancelled)));
            assert!(!fs::try_exists(&cancelled_download_path).await?);
            let mut entries = fs::read_dir(&test_root).await?;
            while let Some(entry) = entries.next_entry().await? {
                assert!(!entry.file_name().to_string_lossy().starts_with("cancelled-download.bin.bx-ssh-part"));
            }
            Ok(())
        }).await?;
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
        run_phase(
            "chmod_uploaded_file",
            phase_timeout,
            sftp.chmod(&remote_path, 0o640),
        )
        .await?;
        let chmod_file = run_phase(
            "verify_uploaded_file_permissions",
            phase_timeout,
            sftp.stat_path(&remote_path),
        )
        .await?;
        if !windows_server {
            assert_eq!(chmod_file.permissions, Some(0o640));
        }

        let download_started = Instant::now();
        let mut download_last_progress_ms = 0;
        let download = run_phase(
            "download_and_verify",
            phase_timeout,
            sftp.download_file_with_progress(
                &remote_path, &download_path, None, SftpConflictAction::Ask,
                &mut |bytes| { if bytes == test_bytes && download_last_progress_ms == 0 {
                    download_last_progress_ms = download_started.elapsed().as_millis();
                } },
            ),
        )
        .await?.expect("the download target is new");
        let download_total_ms = download_started.elapsed().as_millis();
        eprintln!("BX_SFTP_TIMING download_last_progress_ms={download_last_progress_ms} download_durable_ms={} download_total_ms={download_total_ms}", download.elapsed_ms);
        let source_sha256 = hash_local_file(&source_path)
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(upload.sha256, source_sha256);
        assert_eq!(
            source_sha256,
            hash_local_file(&download_path)
                .await
                .map_err(|error| error.to_string())?
        );
        let directory_upload = run_phase(
            "upload_directory",
            phase_timeout,
            sftp.upload_directory(
                &source_directory,
                &remote_directory,
                &ConnectionCancellation::default(),
            ),
        )
        .await?;
        let directory_download = run_phase(
            "download_directory",
            phase_timeout,
            sftp.download_directory(
                &remote_directory,
                &download_directory,
                &ConnectionCancellation::default(),
            ),
        )
        .await?;
        assert!(download_directory.join("empty").is_dir());
        assert_eq!(
            source_sha256,
            hash_local_file(&download_directory.join("deep/a/b/source.bin"))
                .await
                .map_err(|error| error.to_string())?
        );
        run_phase(
            "create_operations_directory",
            phase_timeout,
            sftp.create_directory(&remote_operations),
        )
        .await?;
        run_phase(
            "create_operations_child",
            phase_timeout,
            sftp.create_directory(&format!("{remote_operations}/child")),
        )
        .await?;
        expect_directory_not_empty_phase(
            "reject_non_recursive_directory_delete",
            phase_timeout,
            sftp.delete_entry(&remote_operations, false),
        )
        .await?;
        run_phase(
            "chmod_operations_child",
            phase_timeout,
            sftp.chmod(&format!("{remote_operations}/child"), 0o700),
        )
        .await?;
        let chmod_entry = run_phase(
            "verify_operations_child_permissions",
            phase_timeout,
            sftp.stat_path(&format!("{remote_operations}/child")),
        )
        .await?;
        if !windows_server {
            assert_eq!(chmod_entry.permissions, Some(0o700));
        }
        run_phase(
            "rename_operations_child",
            phase_timeout,
            sftp.rename_entry(
                &format!("{remote_operations}/child"),
                &format!("{remote_operations}/renamed"),
            ),
        )
        .await?;
        run_phase(
            "move_operations_child",
            phase_timeout,
            sftp.move_entry(
                &format!("{remote_operations}/renamed"),
                &format!("{remote_operations}/moved"),
            ),
        )
        .await?;
        run_phase(
            "delete_operations_directory_recursively",
            phase_timeout,
            sftp.delete_entry(&remote_operations, true),
        )
        .await?;
        Ok((
            upload,
            download,
            directory_upload,
            directory_download,
            upload_total_ms,
            download_total_ms,
        ))
    }
    .await;

    cleanup_remote_phase(
        "remove_cancelled_upload_target",
        phase_timeout,
        sftp.remove_file(&cancelled_upload_path),
    )
    .await;
    cleanup_remote_phase(
        "remove_remote_test_file",
        phase_timeout,
        sftp.remove_file(&remote_path),
    )
    .await;
    cleanup_remote_phase(
        "remove_remote_directory_file",
        phase_timeout,
        sftp.remove_file(&format!("{remote_directory}/deep/a/b/source.bin")),
    )
    .await;
    for directory in [
        format!("{remote_directory}/deep/a/b"),
        format!("{remote_directory}/deep/a"),
        format!("{remote_directory}/deep"),
        format!("{remote_directory}/empty"),
        remote_directory.clone(),
    ] {
        cleanup_remote_phase(
            "remove_remote_test_directory",
            phase_timeout,
            sftp.remove_empty_directory(&directory),
        )
        .await;
    }
    cleanup_remote_phase(
        "remove_remote_operations_directory",
        phase_timeout,
        sftp.delete_entry(&remote_operations, true),
    )
    .await;
    cleanup_phase("close_sftp", phase_timeout, sftp.close()).await;
    cleanup_phase("disconnect_ssh", phase_timeout, ssh.disconnect()).await;
    cleanup_phase("remove_local_test_directory", phase_timeout, async {
        fs::remove_dir_all(&test_root).await.map_err(SshError::from)
    })
    .await;

    let (
        upload,
        download,
        directory_upload,
        directory_download,
        upload_total_ms,
        download_total_ms,
    ) = validation.unwrap();
    assert_eq!(upload.bytes, test_bytes);
    assert_eq!(download.bytes, test_bytes);
    assert_eq!(upload.sha256, download.sha256);
    assert_eq!(directory_upload.files, 1);
    assert_eq!(directory_upload.directories, 5);
    assert_eq!(directory_upload.bytes, test_bytes);
    assert_eq!(directory_download.files, directory_upload.files);
    assert_eq!(directory_download.directories, directory_upload.directories);
    assert_eq!(directory_download.bytes, directory_upload.bytes);
    println!(
        "BX_SFTP_RESULT bytes={} upload_bps={} download_bps={} sha256={} required_one_gib={} upload_ms={} download_ms={} upload_total_ms={} download_total_ms={}",
        test_bytes,
        upload.bytes_per_second,
        download.bytes_per_second,
        upload.sha256,
        require_one_gib,
        upload.elapsed_ms,
        download.elapsed_ms,
        upload_total_ms,
        download_total_ms,
    );
    if let (Some(upload_baseline), Some(download_baseline)) =
        (baseline_upload_speed, baseline_download_speed)
    {
        let minimum_upload_speed = minimum_speed(upload_baseline, minimum_speed_percent);
        let minimum_download_speed = minimum_speed(download_baseline, minimum_speed_percent);
        println!(
            "BX_SFTP_SPEED baseline_upload_bps={} baseline_download_bps={} minimum_percent={} minimum_upload_bps={} minimum_download_bps={} upload_percent={} download_percent={}",
            upload_baseline,
            download_baseline,
            minimum_speed_percent,
            minimum_upload_speed,
            minimum_download_speed,
            speed_percent(upload.bytes_per_second, upload_baseline),
            speed_percent(download.bytes_per_second, download_baseline),
        );
        assert!(
            upload.bytes_per_second >= minimum_upload_speed,
            "SFTP upload speed {} B/s is below the {}% OpenSSH upload baseline target of {} B/s (baseline {} B/s)",
            upload.bytes_per_second,
            minimum_speed_percent,
            minimum_upload_speed,
            upload_baseline
        );
        assert!(
            download.bytes_per_second >= minimum_download_speed,
            "SFTP download speed {} B/s is below the {}% OpenSSH download baseline target of {} B/s (baseline {} B/s)",
            download.bytes_per_second,
            minimum_speed_percent,
            minimum_download_speed,
            download_baseline
        );
    }
}

async fn run_phase<T>(
    name: &str,
    phase_timeout: Duration,
    future: impl Future<Output = Result<T, SshError>>,
) -> Result<T, String> {
    eprintln!("BX_SFTP_PHASE name={name} status=started");
    let started = Instant::now();
    match timeout(phase_timeout, future).await {
        Ok(Ok(value)) => {
            eprintln!(
                "BX_SFTP_PHASE name={name} status=completed elapsed_ms={}",
                started.elapsed().as_millis()
            );
            Ok(value)
        }
        Ok(Err(error)) => Err(format!("SFTP phase {name} failed: {error}")),
        Err(_) => Err(format!(
            "SFTP phase {name} timed out after {} seconds",
            phase_timeout.as_secs()
        )),
    }
}

async fn expect_directory_not_empty_phase(
    name: &str,
    phase_timeout: Duration,
    future: impl Future<Output = Result<(), SshError>>,
) -> Result<(), String> {
    eprintln!("BX_SFTP_PHASE name={name} status=started");
    match timeout(phase_timeout, future).await {
        Ok(Err(SshError::RemoteDirectoryNotEmpty)) => {
            eprintln!("BX_SFTP_PHASE name={name} status=completed");
            Ok(())
        }
        Ok(Ok(())) => Err(format!(
            "SFTP phase {name} unexpectedly deleted a non-empty directory"
        )),
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

async fn cleanup_remote_phase(
    name: &str,
    phase_timeout: Duration,
    future: impl Future<Output = Result<(), SshError>>,
) {
    eprintln!("BX_SFTP_PHASE name={name} status=started");
    match timeout(phase_timeout, future).await {
        Ok(Ok(())) => eprintln!("BX_SFTP_PHASE name={name} status=completed"),
        Ok(Err(SshError::Sftp(SftpError::Status(status))))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            eprintln!("BX_SFTP_PHASE name={name} status=completed detail=already_absent")
        }
        Ok(Err(error)) => eprintln!("BX_SFTP_PHASE name={name} status=failed error={error}"),
        Err(_) => eprintln!("BX_SFTP_PHASE name={name} status=timed_out"),
    }
}

async fn create_test_file(path: &Path, bytes: u64) -> Result<(), SshError> {
    if let Some(source) = env::var_os("BX_SSH_TEST_SFTP_SOURCE_FILE") {
        let copied = fs::copy(source, path).await?;
        assert_eq!(
            copied, bytes,
            "the OpenSSH baseline source must have the same size"
        );
        return Ok(());
    }
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

async fn hash_local_file(path: &Path) -> Result<String, SshError> {
    let mut file = File::open(path).await?;
    let mut buffer = vec![0; DATA_BLOCK_BYTES];
    let mut hasher = Sha256::new();
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            return Ok(hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect());
        }
        hasher.update(&buffer[..count]);
    }
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

fn optional_env_u64(name: &str) -> Option<u64> {
    env::var(name).ok().map(|value| {
        value
            .parse()
            .unwrap_or_else(|_| panic!("{name} must be an unsigned integer"))
    })
}

fn minimum_speed(baseline: u64, percentage: u64) -> u64 {
    (u128::from(baseline) * u128::from(percentage))
        .div_ceil(100)
        .min(u128::from(u64::MAX)) as u64
}

fn speed_percent(speed: u64, baseline: u64) -> u64 {
    if baseline == 0 {
        return 0;
    }
    ((u128::from(speed) * 100) / u128::from(baseline)).min(u128::from(u64::MAX)) as u64
}
