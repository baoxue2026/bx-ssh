use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use std::{fmt::Write as _, io};

use bx_contracts::{RemoteDirectoryListing, RemoteFileEntry, RemoteFileKind, TransferSummary};
use russh::client;
use russh_sftp::client::{Config, SftpSession};
use russh_sftp::protocol::FileType;
use sha2::{Digest, Sha256};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::SshError;

const TRANSFER_BUFFER_BYTES: usize = 256 * 1024;
const SFTP_MAX_PACKET_BYTES: u32 = 32 * 1024;
const SFTP_MAX_CONCURRENT_WRITES: usize = 64;
const SFTP_REQUEST_TIMEOUT_SECONDS: u64 = 30;
static TEMPORARY_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct SftpClient {
    session: SftpSession,
}

impl SftpClient {
    pub(crate) async fn open(stream: russh::ChannelStream<client::Msg>) -> Result<Self, SshError> {
        let session = SftpSession::new_with_config(stream, sftp_config()).await?;
        Ok(Self { session })
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String, SshError> {
        Ok(self
            .session
            .canonicalize(validate_remote_path(path)?)
            .await?)
    }

    pub async fn list_directory(&self, path: &str) -> Result<RemoteDirectoryListing, SshError> {
        let canonical_path = self.canonicalize(path).await?;
        let mut entries = self
            .session
            .read_dir(canonical_path.clone())
            .await?
            .map(|entry| {
                let metadata = entry.metadata();
                RemoteFileEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    kind: remote_file_kind(entry.file_type()),
                    size: metadata.len(),
                    modified_at: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions.map(|mode| mode & 0o7777),
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            file_kind_order(left.kind)
                .cmp(&file_kind_order(right.kind))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(RemoteDirectoryListing {
            path: canonical_path,
            entries,
        })
    }

    pub async fn upload_file(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
    ) -> Result<TransferSummary, SshError> {
        let local_path = local_path.as_ref();
        let metadata = fs::metadata(local_path).await?;
        if !metadata.is_file() {
            return Err(SshError::InvalidLocalFile);
        }

        let remote_path = validate_remote_path(remote_path)?;
        if self.session.try_exists(remote_path).await? {
            return Err(SshError::RemoteTargetExists);
        }

        let temporary_path = temporary_remote_path(remote_path);
        let mut local_file = File::open(local_path).await?;
        let mut remote_file = self.session.create(temporary_path.clone()).await?;
        let started_at = Instant::now();
        let result = copy_and_hash(&mut local_file, &mut remote_file).await;

        let summary = match result {
            Ok((bytes, sha256)) => {
                if let Err(error) = remote_file.shutdown().await {
                    let _ = self.session.remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                if let Err(error) = self.session.rename(&temporary_path, remote_path).await {
                    let _ = self.session.remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                transfer_summary(bytes, sha256, started_at)
            }
            Err(error) => {
                let _ = remote_file.shutdown().await;
                let _ = self.session.remove_file(&temporary_path).await;
                return Err(error);
            }
        };

        let remote_summary = match self.hash_remote_file(remote_path).await {
            Ok(summary) => summary,
            Err(error) => {
                let _ = self.session.remove_file(remote_path).await;
                return Err(error);
            }
        };
        if summary.bytes != remote_summary.bytes || summary.sha256 != remote_summary.sha256 {
            let _ = self.session.remove_file(remote_path).await;
            return Err(SshError::TransferIntegrityMismatch {
                expected: summary.sha256,
                actual: remote_summary.sha256,
            });
        }

        Ok(summary)
    }

    pub async fn download_file(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
    ) -> Result<TransferSummary, SshError> {
        let remote_path = validate_remote_path(remote_path)?;
        let local_path = local_path.as_ref();
        if fs::try_exists(local_path).await? {
            return Err(SshError::LocalTargetExists);
        }

        let temporary_path = temporary_local_path(local_path)?;
        let mut remote_file = self.session.open(remote_path).await?;
        let mut local_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .await?;
        let started_at = Instant::now();
        let result = copy_and_hash(&mut remote_file, &mut local_file).await;

        let summary = match result {
            Ok((bytes, sha256)) => {
                if let Err(error) = remote_file.shutdown().await {
                    drop(local_file);
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                if let Err(error) = local_file.flush().await {
                    drop(local_file);
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                if let Err(error) = local_file.sync_all().await {
                    drop(local_file);
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                drop(local_file);
                if let Err(error) = fs::rename(&temporary_path, local_path).await {
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                transfer_summary(bytes, sha256, started_at)
            }
            Err(error) => {
                drop(local_file);
                let _ = fs::remove_file(&temporary_path).await;
                return Err(error);
            }
        };

        let local_summary = match hash_local_file(local_path).await {
            Ok(summary) => summary,
            Err(error) => {
                let _ = fs::remove_file(local_path).await;
                return Err(error);
            }
        };
        if summary.bytes != local_summary.bytes || summary.sha256 != local_summary.sha256 {
            let _ = fs::remove_file(local_path).await;
            return Err(SshError::TransferIntegrityMismatch {
                expected: summary.sha256,
                actual: local_summary.sha256,
            });
        }

        Ok(summary)
    }

    pub async fn hash_remote_file(&self, remote_path: &str) -> Result<TransferSummary, SshError> {
        let mut remote_file = self
            .session
            .open(validate_remote_path(remote_path)?)
            .await?;
        let mut sink = tokio::io::sink();
        let started_at = Instant::now();
        let (bytes, sha256) = copy_and_hash(&mut remote_file, &mut sink).await?;
        remote_file.shutdown().await?;
        Ok(transfer_summary(bytes, sha256, started_at))
    }

    pub async fn remove_file(&self, remote_path: &str) -> Result<(), SshError> {
        self.session
            .remove_file(validate_remote_path(remote_path)?)
            .await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.session.close().await?;
        Ok(())
    }
}

async fn copy_and_hash<R, W>(reader: &mut R, writer: &mut W) -> Result<(u64, String), SshError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0; TRANSFER_BUFFER_BYTES];
    let mut bytes = 0_u64;
    let mut hasher = Sha256::new();

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read]).await?;
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }

    let digest = hasher.finalize();
    let mut sha256 = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut sha256, "{byte:02x}").map_err(io::Error::other)?;
    }
    Ok((bytes, sha256))
}

async fn hash_local_file(path: &Path) -> Result<TransferSummary, SshError> {
    let mut file = File::open(path).await?;
    let mut sink = tokio::io::sink();
    let started_at = Instant::now();
    let (bytes, sha256) = copy_and_hash(&mut file, &mut sink).await?;
    Ok(transfer_summary(bytes, sha256, started_at))
}

fn validate_remote_path(path: &str) -> Result<&str, SshError> {
    if path.trim().is_empty() || path.contains('\0') {
        Err(SshError::InvalidRemotePath)
    } else {
        Ok(path)
    }
}

fn remote_file_kind(kind: FileType) -> RemoteFileKind {
    match kind {
        FileType::Dir => RemoteFileKind::Directory,
        FileType::File => RemoteFileKind::File,
        FileType::Symlink => RemoteFileKind::Symlink,
        FileType::Other => RemoteFileKind::Other,
    }
}

fn file_kind_order(kind: RemoteFileKind) -> u8 {
    match kind {
        RemoteFileKind::Directory => 0,
        RemoteFileKind::File => 1,
        RemoteFileKind::Symlink => 2,
        RemoteFileKind::Other => 3,
    }
}

fn temporary_remote_path(remote_path: &str) -> String {
    format!(
        "{remote_path}.bx-ssh-part-{}-{}",
        std::process::id(),
        TEMPORARY_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn temporary_local_path(local_path: &Path) -> Result<PathBuf, SshError> {
    let file_name = local_path
        .file_name()
        .ok_or(SshError::InvalidLocalFile)?
        .to_string_lossy();
    let temporary_name = format!(
        ".{file_name}.bx-ssh-part-{}-{}",
        std::process::id(),
        TEMPORARY_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    Ok(local_path.with_file_name(temporary_name))
}

fn transfer_summary(bytes: u64, sha256: String, started_at: Instant) -> TransferSummary {
    let elapsed = started_at.elapsed();
    let elapsed_ms = elapsed.as_millis().max(1) as u64;
    let bytes_per_second = ((bytes as u128 * 1000) / elapsed_ms as u128) as u64;
    TransferSummary {
        bytes,
        elapsed_ms,
        bytes_per_second,
        sha256,
    }
}

fn sftp_config() -> Config {
    Config {
        max_packet_len: SFTP_MAX_PACKET_BYTES,
        max_concurrent_writes: SFTP_MAX_CONCURRENT_WRITES,
        request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECONDS,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use bx_contracts::RemoteFileKind;

    use super::{file_kind_order, sftp_config, temporary_local_path, validate_remote_path};
    use crate::SshError;

    #[test]
    fn validates_remote_paths() {
        assert_eq!(validate_remote_path("/tmp/file").unwrap(), "/tmp/file");
        assert!(matches!(
            validate_remote_path("  "),
            Err(SshError::InvalidRemotePath)
        ));
        assert!(matches!(
            validate_remote_path("bad\0path"),
            Err(SshError::InvalidRemotePath)
        ));
    }

    #[test]
    fn creates_temporary_file_next_to_the_download_target() {
        let target = Path::new("C:/downloads/archive.tar");
        let temporary = temporary_local_path(target).unwrap();

        assert_eq!(temporary.parent(), target.parent());
        assert!(temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("archive.tar.bx-ssh-part"));
    }

    #[test]
    fn sorts_directories_before_files() {
        assert!(file_kind_order(RemoteFileKind::Directory) < file_kind_order(RemoteFileKind::File));
    }

    #[test]
    fn pipelines_small_sftp_write_packets() {
        let config = sftp_config();

        assert_eq!(config.max_packet_len, 32 * 1024);
        assert_eq!(config.max_concurrent_writes, 64);
        assert_eq!(config.request_timeout_secs, 30);
    }
}
