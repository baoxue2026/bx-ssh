use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use std::{fmt::Write as _, io};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use bx_contracts::{
    RemoteDirectoryListing, RemoteFileEntry, RemoteFileKind, SftpConflictAction,
    TransferBatchSummary, TransferSummary,
};
use russh::client;
use russh_sftp::client::{error::Error as SftpError, Config, SftpSession};
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use sha2::{Digest, Sha256};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufWriter};
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::MoveFileW;

use crate::sftp_read::ReadAheadSession;
use crate::{ConnectionCancellation, SshError};

const TRANSFER_BUFFER_BYTES: usize = 256 * 1024;
// Keep the packet size compatible with older OpenSSH SFTP servers. Larger
// packets are rejected by the Windows OpenSSH 8.1 compatibility target.
const SFTP_MAX_PACKET_BYTES: u32 = 64 * 1024;
const SFTP_MAX_CONCURRENT_WRITES: usize = 64;
const SFTP_REQUEST_TIMEOUT_SECONDS: u64 = 30;
static TEMPORARY_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct SftpClient {
    session: SftpSession,
    read_ahead: Option<ReadAheadSession>,
}

struct CreatedRemoteEntries {
    files: Vec<String>,
    directories: Vec<String>,
}

struct CreatedLocalEntries {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
}

impl SftpClient {
    pub(crate) async fn open(stream: russh::ChannelStream<client::Msg>) -> Result<Self, SshError> {
        let session = SftpSession::new_with_config(stream, sftp_config()).await?;
        Ok(Self {
            session,
            read_ahead: None,
        })
    }

    pub(crate) async fn enable_read_ahead(&mut self, stream: russh::ChannelStream<client::Msg>) {
        self.read_ahead = ReadAheadSession::open(stream, sftp_config()).await.ok();
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String, SshError> {
        let path = validate_remote_path(path)?;
        self.reject_remote_symlink_components(path, true).await?;
        Ok(normalize_remote_path(
            self.session.canonicalize(path).await?,
        ))
    }

    pub async fn list_directory(&self, path: &str) -> Result<RemoteDirectoryListing, SshError> {
        let canonical_path = self.canonicalize(path).await?;
        let mut entries = self
            .session
            .read_dir(canonical_path.clone())
            .await?
            .map(|entry| {
                let name = entry.file_name();
                let path = join_remote_path(&canonical_path, &name);
                validate_remote_entry_name(&name, &path)?;
                let metadata = entry.metadata();
                Ok(RemoteFileEntry {
                    name,
                    path,
                    kind: remote_file_kind(entry.file_type()),
                    size: metadata.len(),
                    modified_at: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions.map(|mode| mode & 0o7777),
                })
            })
            .collect::<Result<Vec<_>, SshError>>()?;
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

    pub async fn stat_path(&self, path: &str) -> Result<RemoteFileEntry, SshError> {
        let path = validate_remote_path(path)?;
        self.reject_remote_symlink_components(path, false).await?;
        let metadata = self.session.symlink_metadata(path.to_owned()).await?;
        let canonical_path = if metadata.file_type() == FileType::Symlink {
            self.canonicalize_remote_leaf(path).await?
        } else {
            normalize_remote_path(self.session.canonicalize(path).await?)
        };
        let name = Path::new(&canonical_path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| canonical_path.clone());
        Ok(RemoteFileEntry {
            name,
            path: canonical_path,
            kind: remote_file_kind(metadata.file_type()),
            size: metadata.len(),
            modified_at: metadata.mtime.map(u64::from),
            permissions: metadata.permissions.map(|mode| mode & 0o7777),
        })
    }

    pub async fn upload_file(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
    ) -> Result<TransferSummary, SshError> {
        self.upload_file_with_conflict(local_path, remote_path, SftpConflictAction::Ask)
            .await?
            .ok_or(SshError::RemoteTargetExists)
    }

    pub async fn upload_file_with_conflict(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        conflict_action: SftpConflictAction,
    ) -> Result<Option<TransferSummary>, SshError> {
        self.upload_file_with_cancellation(local_path, remote_path, None, conflict_action)
            .await
    }

    async fn upload_file_with_cancellation(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: Option<&ConnectionCancellation>,
        conflict_action: SftpConflictAction,
    ) -> Result<Option<TransferSummary>, SshError> {
        self.upload_file_with_cancellation_and_progress(
            local_path,
            remote_path,
            cancellation,
            conflict_action,
            &mut |_| {},
        )
        .await
    }

    pub async fn upload_file_with_progress(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: Option<&ConnectionCancellation>,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<Option<TransferSummary>, SshError> {
        self.upload_file_with_cancellation_and_progress(
            local_path,
            remote_path,
            cancellation,
            conflict_action,
            on_progress,
        )
        .await
    }

    async fn upload_file_with_cancellation_and_progress(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: Option<&ConnectionCancellation>,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<Option<TransferSummary>, SshError> {
        let local_path = local_path.as_ref();
        check_transfer_cancellation(cancellation)?;
        reject_local_symlink_components(local_path, true).await?;
        let metadata = fs::metadata(local_path).await?;
        if !metadata.is_file() {
            return Err(SshError::InvalidLocalFile);
        }

        let remote_path = validate_remote_path(remote_path)?.to_owned();
        self.reject_remote_symlink_components(&remote_path, false)
            .await?;
        let Some(remote_path) = self
            .resolve_remote_file_target(&remote_path, conflict_action)
            .await?
        else {
            return Ok(None);
        };

        let temporary_path = temporary_remote_path(&remote_path);
        let mut local_file = File::open(local_path).await?;
        let mut remote_file = self
            .session
            .open_with_flags(
                temporary_path.clone(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await?;
        let started_at = Instant::now();
        let result = copy_and_hash_with_progress(
            &mut local_file,
            &mut remote_file,
            cancellation,
            on_progress,
        )
        .await;

        let summary = match result {
            Ok((bytes, sha256)) => {
                if let Err(error) = remote_file.shutdown().await {
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

        let remote_summary = match self
            .hash_remote_file_with_cancellation(&temporary_path, cancellation)
            .await
        {
            Ok(summary) => summary,
            Err(error) => {
                let _ = self.session.remove_file(&temporary_path).await;
                return Err(error);
            }
        };
        if let Err(error) = verify_transfer_integrity(&summary, &remote_summary) {
            let _ = self.session.remove_file(&temporary_path).await;
            return Err(error);
        }
        if let Err(error) = check_transfer_cancellation(cancellation) {
            let _ = self.session.remove_file(&temporary_path).await;
            return Err(error);
        }
        if let Err(error) = self
            .publish_remote_file(&temporary_path, &remote_path, conflict_action)
            .await
        {
            let _ = self.session.remove_file(&temporary_path).await;
            return Err(error);
        }

        Ok(Some(summary))
    }

    pub async fn upload_directory(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: &ConnectionCancellation,
    ) -> Result<TransferBatchSummary, SshError> {
        self.upload_directory_with_conflict(
            local_path,
            remote_path,
            cancellation,
            SftpConflictAction::Ask,
        )
        .await
    }

    pub async fn upload_directory_with_conflict(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: &ConnectionCancellation,
        conflict_action: SftpConflictAction,
    ) -> Result<TransferBatchSummary, SshError> {
        self.upload_directory_with_conflict_and_progress(
            local_path,
            remote_path,
            cancellation,
            conflict_action,
            &mut |_| {},
        )
        .await
    }

    pub async fn upload_directory_with_progress(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: &ConnectionCancellation,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<TransferBatchSummary, SshError> {
        self.upload_directory_with_conflict_and_progress(
            local_path,
            remote_path,
            cancellation,
            conflict_action,
            on_progress,
        )
        .await
    }

    async fn upload_directory_with_conflict_and_progress(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancellation: &ConnectionCancellation,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<TransferBatchSummary, SshError> {
        let local_path = local_path.as_ref();
        check_transfer_cancellation(Some(cancellation))?;
        reject_local_symlink_components(local_path, true).await?;
        let metadata = fs::symlink_metadata(local_path).await?;
        if !metadata.is_dir() {
            return Err(SshError::InvalidLocalDirectory);
        }
        let remote_path = validate_remote_path(remote_path)?.to_owned();
        self.reject_remote_symlink_components(&remote_path, false)
            .await?;
        let Some((remote_path, root_created)) = self
            .resolve_remote_directory_target(&remote_path, conflict_action)
            .await?
        else {
            return Ok(batch_summary(0, 0, 0, Instant::now()));
        };

        let mut root_created = root_created;
        if root_created {
            if let Err(error) = self.session.create_dir(remote_path.clone()).await {
                match self.remote_entry_type(&remote_path).await {
                    Ok(Some(FileType::Dir)) if conflict_action == SftpConflictAction::Overwrite => {
                        root_created = false;
                    }
                    Ok(Some(_)) => return Err(SshError::RemoteTargetExists),
                    _ => return Err(error.into()),
                }
            }
        } else if !matches!(
            self.remote_entry_metadata(&remote_path).await?,
            Some(metadata) if metadata.file_type() == FileType::Dir
        ) {
            return Err(SshError::RemoteTargetExists);
        }
        let mut created = CreatedRemoteEntries {
            files: Vec::new(),
            directories: if root_created {
                vec![remote_path.clone()]
            } else {
                Vec::new()
            },
        };
        let started_at = Instant::now();
        let result = self
            .upload_directory_contents(
                local_path,
                &remote_path,
                cancellation,
                &mut created,
                conflict_action,
                on_progress,
            )
            .await;
        match result {
            Ok((files, directories, bytes)) => {
                Ok(batch_summary(files, directories, bytes, started_at))
            }
            Err(error) => match self.cleanup_remote_entries(&created).await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(SshError::TransferCleanupFailed {
                    transfer: error.to_string(),
                    cleanup: cleanup.to_string(),
                }),
            },
        }
    }

    async fn upload_directory_contents(
        &self,
        local_path: &Path,
        remote_path: &str,
        cancellation: &ConnectionCancellation,
        created: &mut CreatedRemoteEntries,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<(u64, u64, u64), SshError> {
        let mut pending = vec![(local_path.to_owned(), remote_path.to_owned())];
        let mut files = 0;
        let mut directories = 1;
        let mut bytes = 0;
        while let Some((local_directory, remote_directory)) = pending.pop() {
            check_transfer_cancellation(Some(cancellation))?;
            let mut reader = fs::read_dir(&local_directory).await?;
            while let Some(entry) = reader.next_entry().await? {
                check_transfer_cancellation(Some(cancellation))?;
                let local_child = entry.path();
                let metadata = fs::symlink_metadata(&local_child).await?;
                let name = entry.file_name().into_string().map_err(|_| {
                    SshError::UnsupportedTransferEntry {
                        path: local_child.to_string_lossy().into_owned(),
                    }
                })?;
                let remote_child = join_remote_path(&remote_directory, &name);
                if metadata.is_dir() {
                    let Some((remote_child, child_created)) = self
                        .resolve_remote_directory_target(&remote_child, conflict_action)
                        .await?
                    else {
                        continue;
                    };
                    let mut created_child = child_created;
                    if child_created {
                        if let Err(error) = self.session.create_dir(remote_child.clone()).await {
                            match self.remote_entry_exists(&remote_child).await {
                                Ok(true) if conflict_action == SftpConflictAction::Overwrite => {
                                    created_child = false;
                                }
                                Ok(true) => return Err(SshError::RemoteTargetExists),
                                _ => return Err(error.into()),
                            }
                        }
                    }
                    if created_child {
                        created.directories.push(remote_child.clone());
                    }
                    pending.push((local_child, remote_child));
                    directories += 1;
                } else if metadata.is_file() {
                    let target_existed = self.remote_entry_exists(&remote_child).await?;
                    let Some(remote_child) = self
                        .resolve_remote_file_target(&remote_child, conflict_action)
                        .await?
                    else {
                        continue;
                    };
                    if let Some(summary) = self
                        .upload_file_with_cancellation_and_progress(
                            &local_child,
                            &remote_child,
                            Some(cancellation),
                            conflict_action,
                            &mut |file_bytes| on_progress(bytes + file_bytes),
                        )
                        .await?
                    {
                        if conflict_action != SftpConflictAction::Overwrite || !target_existed {
                            created.files.push(remote_child);
                        }
                        files += 1;
                        bytes += summary.bytes;
                    }
                } else {
                    return Err(SshError::UnsupportedTransferEntry {
                        path: local_child.to_string_lossy().into_owned(),
                    });
                }
            }
        }
        Ok((files, directories, bytes))
    }

    pub async fn download_file(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
    ) -> Result<TransferSummary, SshError> {
        self.download_file_with_conflict(remote_path, local_path, SftpConflictAction::Ask)
            .await?
            .ok_or(SshError::LocalTargetExists)
    }

    pub async fn download_file_with_conflict(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        conflict_action: SftpConflictAction,
    ) -> Result<Option<TransferSummary>, SshError> {
        self.download_file_with_cancellation(remote_path, local_path, None, conflict_action)
            .await
    }

    async fn download_file_with_cancellation(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: Option<&ConnectionCancellation>,
        conflict_action: SftpConflictAction,
    ) -> Result<Option<TransferSummary>, SshError> {
        self.download_file_with_cancellation_and_progress(
            remote_path,
            local_path,
            cancellation,
            conflict_action,
            &mut |_| {},
        )
        .await
    }

    pub async fn download_file_with_progress(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: Option<&ConnectionCancellation>,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<Option<TransferSummary>, SshError> {
        self.download_file_with_cancellation_and_progress(
            remote_path,
            local_path,
            cancellation,
            conflict_action,
            on_progress,
        )
        .await
    }

    async fn download_file_with_cancellation_and_progress(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: Option<&ConnectionCancellation>,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<Option<TransferSummary>, SshError> {
        let remote_path = validate_remote_path(remote_path)?;
        let local_path = local_path.as_ref();
        check_transfer_cancellation(cancellation)?;
        self.reject_remote_symlink_components(remote_path, true)
            .await?;
        reject_local_symlink_components(local_path, false).await?;
        let Some(local_path) = resolve_local_file_target(local_path, conflict_action).await? else {
            return Ok(None);
        };

        let temporary_path = temporary_local_path(&local_path)?;
        let local_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .await?;
        let mut local_file = BufWriter::with_capacity(1024 * 1024, local_file);
        let started_at = Instant::now();
        let result = self
            .copy_remote_with_progress(remote_path, &mut local_file, cancellation, on_progress)
            .await;

        let summary = match result {
            Ok((bytes, sha256)) => {
                if let Err(error) = local_file.flush().await {
                    drop(local_file);
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                if let Err(error) = local_file.get_ref().sync_all().await {
                    drop(local_file);
                    let _ = fs::remove_file(&temporary_path).await;
                    return Err(error.into());
                }
                drop(local_file);
                transfer_summary(bytes, sha256, started_at)
            }
            Err(error) => {
                drop(local_file);
                let _ = fs::remove_file(&temporary_path).await;
                return Err(error);
            }
        };

        let local_summary = match hash_local_file(&temporary_path, cancellation).await {
            Ok(summary) => summary,
            Err(error) => {
                let _ = fs::remove_file(&temporary_path).await;
                return Err(error);
            }
        };
        if let Err(error) = verify_transfer_integrity(&summary, &local_summary) {
            let _ = fs::remove_file(&temporary_path).await;
            return Err(error);
        }
        if let Err(error) = check_transfer_cancellation(cancellation) {
            let _ = fs::remove_file(&temporary_path).await;
            return Err(error);
        }
        if let Err(error) =
            publish_local_file_with_conflict(&temporary_path, &local_path, conflict_action).await
        {
            let _ = fs::remove_file(&temporary_path).await;
            return Err(error);
        }

        Ok(Some(summary))
    }

    pub async fn download_directory(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: &ConnectionCancellation,
    ) -> Result<TransferBatchSummary, SshError> {
        self.download_directory_with_conflict(
            remote_path,
            local_path,
            cancellation,
            SftpConflictAction::Ask,
        )
        .await
    }

    pub async fn download_directory_with_conflict(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: &ConnectionCancellation,
        conflict_action: SftpConflictAction,
    ) -> Result<TransferBatchSummary, SshError> {
        self.download_directory_with_conflict_and_progress(
            remote_path,
            local_path,
            cancellation,
            conflict_action,
            &mut |_| {},
        )
        .await
    }

    pub async fn download_directory_with_progress(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: &ConnectionCancellation,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<TransferBatchSummary, SshError> {
        self.download_directory_with_conflict_and_progress(
            remote_path,
            local_path,
            cancellation,
            conflict_action,
            on_progress,
        )
        .await
    }

    async fn download_directory_with_conflict_and_progress(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancellation: &ConnectionCancellation,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<TransferBatchSummary, SshError> {
        check_transfer_cancellation(Some(cancellation))?;
        let remote_path = validate_remote_path(remote_path)?.to_owned();
        self.reject_remote_symlink_components(&remote_path, true)
            .await?;
        let metadata = self.session.symlink_metadata(remote_path.clone()).await?;
        if !matches!(metadata.file_type(), FileType::Dir) {
            return Err(SshError::InvalidRemoteDirectory);
        }
        let remote_path = self.canonicalize(&remote_path).await?;
        let local_path = local_path.as_ref();
        reject_local_symlink_components(local_path, false).await?;
        let Some((local_path, root_created)) =
            resolve_local_directory_target(local_path, conflict_action).await?
        else {
            return Ok(batch_summary(0, 0, 0, Instant::now()));
        };
        if root_created {
            fs::create_dir(&local_path)
                .await
                .map_err(map_local_directory_create_error)?;
        }
        let mut created = CreatedLocalEntries {
            files: Vec::new(),
            directories: if root_created {
                vec![local_path.to_owned()]
            } else {
                Vec::new()
            },
        };
        let started_at = Instant::now();
        let result = self
            .download_directory_contents(
                &remote_path,
                &local_path,
                cancellation,
                &mut created,
                conflict_action,
                on_progress,
            )
            .await;
        match result {
            Ok((files, directories, bytes)) => {
                Ok(batch_summary(files, directories, bytes, started_at))
            }
            Err(error) => match cleanup_local_entries(&created).await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(SshError::TransferCleanupFailed {
                    transfer: error.to_string(),
                    cleanup: cleanup.to_string(),
                }),
            },
        }
    }

    async fn download_directory_contents(
        &self,
        remote_path: &str,
        local_path: &Path,
        cancellation: &ConnectionCancellation,
        created: &mut CreatedLocalEntries,
        conflict_action: SftpConflictAction,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<(u64, u64, u64), SshError> {
        let mut pending = vec![(remote_path.to_owned(), local_path.to_owned())];
        let mut files = 0;
        let mut directories = 1;
        let mut bytes = 0;
        while let Some((remote_directory, local_directory)) = pending.pop() {
            check_transfer_cancellation(Some(cancellation))?;
            let entries = self.session.read_dir(remote_directory.clone()).await?;
            for entry in entries {
                check_transfer_cancellation(Some(cancellation))?;
                let name = entry.file_name();
                let remote_child = join_remote_path(&remote_directory, &name);
                validate_remote_entry_name(&name, &remote_child)?;
                let local_child = local_directory.join(&name);
                match entry.file_type() {
                    FileType::Dir => {
                        let Some((local_child, child_created)) =
                            resolve_local_directory_target(&local_child, conflict_action).await?
                        else {
                            continue;
                        };
                        if child_created {
                            fs::create_dir(&local_child)
                                .await
                                .map_err(map_local_directory_create_error)?;
                            created.directories.push(local_child.clone());
                        }
                        pending.push((remote_child, local_child));
                        directories += 1;
                    }
                    FileType::File => {
                        let target_existed = local_entry_metadata(&local_child).await?.is_some();
                        let Some(local_target) =
                            resolve_local_file_target(&local_child, conflict_action).await?
                        else {
                            continue;
                        };
                        let file_action = if conflict_action == SftpConflictAction::Overwrite {
                            SftpConflictAction::Overwrite
                        } else {
                            SftpConflictAction::Ask
                        };
                        let Some(summary) = self
                            .download_file_with_cancellation_and_progress(
                                &remote_child,
                                &local_target,
                                Some(cancellation),
                                file_action,
                                &mut |file_bytes| on_progress(bytes + file_bytes),
                            )
                            .await?
                        else {
                            continue;
                        };
                        if conflict_action != SftpConflictAction::Overwrite || !target_existed {
                            created.files.push(local_target);
                        }
                        files += 1;
                        bytes += summary.bytes;
                    }
                    _ => {
                        return Err(SshError::UnsupportedTransferEntry { path: remote_child });
                    }
                }
            }
        }
        Ok((files, directories, bytes))
    }

    async fn cleanup_remote_entries(&self, created: &CreatedRemoteEntries) -> Result<(), SshError> {
        let mut first_error = None;
        for path in created.files.iter().rev() {
            if let Err(error) = self.session.remove_file(path.clone()).await {
                first_error.get_or_insert_with(|| SshError::from(error));
            }
        }
        for path in created.directories.iter().rev() {
            if let Err(error) = self.session.remove_dir(path.clone()).await {
                first_error.get_or_insert_with(|| SshError::from(error));
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub async fn hash_remote_file(&self, remote_path: &str) -> Result<TransferSummary, SshError> {
        self.hash_remote_file_with_cancellation(remote_path, None)
            .await
    }

    async fn hash_remote_file_with_cancellation(
        &self,
        remote_path: &str,
        cancellation: Option<&ConnectionCancellation>,
    ) -> Result<TransferSummary, SshError> {
        check_transfer_cancellation(cancellation)?;
        let remote_path = validate_remote_path(remote_path)?;
        self.reject_remote_symlink_components(remote_path, true)
            .await?;
        let mut sink = tokio::io::sink();
        let started_at = Instant::now();
        let (bytes, sha256) = self
            .copy_remote_with_progress(remote_path, &mut sink, cancellation, &mut |_| {})
            .await?;
        Ok(transfer_summary(bytes, sha256, started_at))
    }

    async fn copy_remote_with_progress<W>(
        &self,
        remote_path: &str,
        writer: &mut W,
        cancellation: Option<&ConnectionCancellation>,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<(u64, String), SshError>
    where
        W: AsyncWrite + Unpin + Send,
    {
        if let Some(reader) = &self.read_ahead {
            return reader
                .copy_to(remote_path, writer, cancellation, on_progress)
                .await;
        }
        let mut remote_file = self.session.open(remote_path).await?;
        let result =
            copy_and_hash_with_progress(&mut remote_file, writer, cancellation, on_progress).await;
        let close_result = remote_file.shutdown().await;
        let result = result?;
        close_result?;
        Ok(result)
    }

    pub async fn remove_file(&self, remote_path: &str) -> Result<(), SshError> {
        let remote_path = validate_remote_path(remote_path)?;
        self.reject_remote_symlink_components(remote_path, false)
            .await?;
        self.session.remove_file(remote_path).await?;
        Ok(())
    }

    pub async fn create_directory(&self, remote_path: &str) -> Result<(), SshError> {
        let remote_path = validate_mutation_path(remote_path)?;
        self.reject_remote_symlink_components(remote_path, false)
            .await?;
        if self.remote_entry_exists(remote_path).await? {
            return Err(SshError::RemoteTargetExists);
        }
        self.session.create_dir(remote_path).await?;
        Ok(())
    }

    pub async fn delete_entry(&self, remote_path: &str, recursive: bool) -> Result<(), SshError> {
        let remote_path = validate_mutation_path(remote_path)?.to_owned();
        self.reject_remote_symlink_components(&remote_path, false)
            .await?;
        let metadata = self.session.symlink_metadata(remote_path.clone()).await?;
        match metadata.file_type() {
            FileType::Dir => self.delete_directory(&remote_path, recursive).await,
            FileType::File | FileType::Symlink => {
                self.session.remove_file(remote_path).await?;
                Ok(())
            }
            FileType::Other => Err(SshError::UnsupportedTransferEntry { path: remote_path }),
        }
    }

    async fn delete_directory(&self, remote_path: &str, recursive: bool) -> Result<(), SshError> {
        if !recursive {
            let entries = self.session.read_dir(remote_path.to_owned()).await?;
            if entries.into_iter().next().is_some() {
                return Err(SshError::RemoteDirectoryNotEmpty);
            }
            self.session.remove_dir(remote_path.to_owned()).await?;
            return Ok(());
        }

        let mut pending = vec![remote_path.to_owned()];
        let mut directories = Vec::new();
        while let Some(directory) = pending.pop() {
            directories.push(directory.clone());
            let entries = self.session.read_dir(directory.clone()).await?;
            for entry in entries {
                let name = entry.file_name();
                let child = join_remote_path(&directory, &name);
                validate_remote_entry_name(&name, &child)?;
                match entry.file_type() {
                    FileType::Dir => pending.push(child),
                    FileType::File | FileType::Symlink => {
                        self.session.remove_file(child).await?;
                    }
                    FileType::Other => {
                        return Err(SshError::UnsupportedTransferEntry { path: child });
                    }
                }
            }
        }
        for directory in directories.into_iter().rev() {
            self.session.remove_dir(directory).await?;
        }
        Ok(())
    }

    pub async fn move_entry(&self, source_path: &str, target_path: &str) -> Result<(), SshError> {
        self.rename_entry(source_path, target_path).await
    }

    pub async fn rename_entry(&self, source_path: &str, target_path: &str) -> Result<(), SshError> {
        let source_path = validate_mutation_path(source_path)?.to_owned();
        let target_path = validate_mutation_path(target_path)?.to_owned();
        self.reject_remote_symlink_components(&source_path, false)
            .await?;
        self.reject_remote_symlink_components(&target_path, false)
            .await?;
        let source_metadata = self.session.symlink_metadata(source_path.clone()).await?;
        if source_path == target_path
            || (matches!(source_metadata.file_type(), FileType::Dir)
                && is_remote_descendant(&source_path, &target_path))
        {
            return Err(SshError::InvalidRemotePath);
        }
        if self.remote_entry_exists(&target_path).await? {
            return Err(SshError::RemoteTargetExists);
        }
        self.session.rename(source_path, target_path).await?;
        Ok(())
    }

    pub async fn chmod(&self, remote_path: &str, permissions: u32) -> Result<(), SshError> {
        validate_remote_permissions(permissions)?;
        let remote_path = validate_mutation_path(remote_path)?.to_owned();
        self.reject_remote_symlink_components(&remote_path, true)
            .await?;
        let metadata = self.session.symlink_metadata(remote_path.clone()).await?;
        if matches!(metadata.file_type(), FileType::Symlink | FileType::Other) {
            return Err(SshError::UnsupportedTransferEntry { path: remote_path });
        }
        self.session
            .set_metadata(
                remote_path,
                FileAttributes {
                    permissions: Some(permissions),
                    ..FileAttributes::empty()
                },
            )
            .await?;
        Ok(())
    }

    async fn remote_entry_metadata(
        &self,
        remote_path: &str,
    ) -> Result<Option<russh_sftp::client::fs::Metadata>, SshError> {
        match self.session.symlink_metadata(remote_path.to_owned()).await {
            Ok(metadata) => Ok(Some(metadata)),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn reject_remote_symlink_components(
        &self,
        path: &str,
        include_leaf: bool,
    ) -> Result<(), SshError> {
        let path = validate_remote_path(path)?;
        let mut current = if path.starts_with('/') {
            "/".to_owned()
        } else {
            ".".to_owned()
        };
        let components = path
            .split('/')
            .filter(|component| !component.is_empty() && *component != ".")
            .collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            current = join_remote_path(&current, component);
            let metadata = match self.session.symlink_metadata(current.clone()).await {
                Ok(metadata) => metadata,
                Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                    break
                }
                Err(error) => return Err(error.into()),
            };
            if metadata.file_type() == FileType::Symlink
                && (include_leaf || index + 1 < components.len())
            {
                return Err(SshError::UnsupportedTransferEntry { path: current });
            }
        }
        Ok(())
    }

    async fn canonicalize_remote_leaf(&self, path: &str) -> Result<String, SshError> {
        let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
        let parent = if parent.is_empty() { "/" } else { parent };
        if name.is_empty() {
            return self
                .session
                .canonicalize(path)
                .await
                .map(normalize_remote_path)
                .map_err(Into::into);
        }
        let canonical_parent = self.canonicalize(parent).await?;
        Ok(join_remote_path(&canonical_parent, name))
    }

    async fn publish_remote_file(
        &self,
        temporary_path: &str,
        remote_path: &str,
        conflict_action: SftpConflictAction,
    ) -> Result<(), SshError> {
        let Some(metadata) = self.remote_entry_metadata(remote_path).await? else {
            self.session
                .rename(temporary_path, remote_path.to_owned())
                .await?;
            return Ok(());
        };
        if conflict_action != SftpConflictAction::Overwrite
            || !matches!(metadata.file_type(), FileType::File | FileType::Symlink)
        {
            return Err(SshError::RemoteTargetExists);
        }

        let backup_path = temporary_remote_backup_path(remote_path);
        self.session
            .rename(remote_path.to_owned(), backup_path.clone())
            .await?;
        if let Err(publish_error) = self
            .session
            .rename(temporary_path, remote_path.to_owned())
            .await
        {
            return match self
                .session
                .rename(backup_path, remote_path.to_owned())
                .await
            {
                Ok(()) => Err(publish_error.into()),
                Err(restore_error) => Err(SshError::TransferCleanupFailed {
                    transfer: publish_error.to_string(),
                    cleanup: restore_error.to_string(),
                }),
            };
        }
        self.session
            .remove_file(backup_path)
            .await
            .map_err(|error| SshError::TransferCleanupFailed {
                transfer: "remote replacement was published".to_owned(),
                cleanup: error.to_string(),
            })?;
        Ok(())
    }

    async fn resolve_remote_file_target(
        &self,
        remote_path: &str,
        conflict_action: SftpConflictAction,
    ) -> Result<Option<String>, SshError> {
        let Some(metadata) = self.remote_entry_metadata(remote_path).await? else {
            return Ok(Some(remote_path.to_owned()));
        };
        match conflict_action {
            SftpConflictAction::Ask => Err(SshError::RemoteTargetExists),
            SftpConflictAction::Skip => Ok(None),
            SftpConflictAction::Overwrite => {
                if matches!(metadata.file_type(), FileType::File | FileType::Symlink) {
                    Ok(Some(remote_path.to_owned()))
                } else {
                    Err(SshError::RemoteTargetExists)
                }
            }
            SftpConflictAction::Rename => Ok(Some(self.unique_remote_path(remote_path).await?)),
        }
    }

    async fn resolve_remote_directory_target(
        &self,
        remote_path: &str,
        conflict_action: SftpConflictAction,
    ) -> Result<Option<(String, bool)>, SshError> {
        let Some(metadata) = self.remote_entry_metadata(remote_path).await? else {
            return Ok(Some((remote_path.to_owned(), true)));
        };
        match conflict_action {
            SftpConflictAction::Ask => Err(SshError::RemoteTargetExists),
            SftpConflictAction::Skip => Ok(None),
            SftpConflictAction::Overwrite => {
                if metadata.file_type() == FileType::Dir {
                    Ok(Some((remote_path.to_owned(), false)))
                } else {
                    Err(SshError::RemoteTargetExists)
                }
            }
            SftpConflictAction::Rename => {
                Ok(Some((self.unique_remote_path(remote_path).await?, true)))
            }
        }
    }

    async fn unique_remote_path(&self, remote_path: &str) -> Result<String, SshError> {
        let (parent, name) = remote_path.rsplit_once('/').unwrap_or(("", remote_path));
        for index in 1..=10_000 {
            let candidate_name = auto_rename_name(name, index);
            let candidate = if parent.is_empty() {
                candidate_name
            } else if parent == "/" {
                format!("/{candidate_name}")
            } else {
                format!("{parent}/{candidate_name}")
            };
            if !self.remote_entry_exists(&candidate).await? {
                return Ok(candidate);
            }
        }
        Err(SshError::RemoteTargetExists)
    }

    async fn remote_entry_exists(&self, remote_path: &str) -> Result<bool, SshError> {
        Ok(self.remote_entry_metadata(remote_path).await?.is_some())
    }

    async fn remote_entry_type(&self, remote_path: &str) -> Result<Option<FileType>, SshError> {
        Ok(self
            .remote_entry_metadata(remote_path)
            .await?
            .map(|metadata| metadata.file_type()))
    }

    pub async fn remove_empty_directory(&self, remote_path: &str) -> Result<(), SshError> {
        self.session
            .remove_dir(validate_remote_path(remote_path)?)
            .await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<(), SshError> {
        let read_result = self
            .read_ahead
            .as_ref()
            .map(ReadAheadSession::close)
            .transpose();
        let session_result = self.session.close().await;
        read_result?;
        session_result?;
        Ok(())
    }
}

async fn copy_and_hash_with_cancellation<R, W>(
    reader: &mut R,
    writer: &mut W,
    cancellation: Option<&ConnectionCancellation>,
) -> Result<(u64, String), SshError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    copy_and_hash_with_progress(reader, writer, cancellation, &mut |_| {}).await
}

async fn copy_and_hash_with_progress<R, W>(
    reader: &mut R,
    writer: &mut W,
    cancellation: Option<&ConnectionCancellation>,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(u64, String), SshError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0; TRANSFER_BUFFER_BYTES];
    let mut bytes = 0_u64;
    let mut hasher = Sha256::new();

    loop {
        let read = match cancellation {
            Some(cancellation) => {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(SshError::TransferCancelled),
                    result = reader.read(&mut buffer) => result?,
                }
            }
            None => reader.read(&mut buffer).await?,
        };
        if read == 0 {
            break;
        }
        match cancellation {
            Some(cancellation) => {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(SshError::TransferCancelled),
                    result = writer.write_all(&buffer[..read]) => result?,
                }
            }
            None => writer.write_all(&buffer[..read]).await?,
        }
        hasher.update(&buffer[..read]);
        bytes += read as u64;
        on_progress(bytes);
    }

    let digest = hasher.finalize();
    let mut sha256 = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut sha256, "{byte:02x}").map_err(io::Error::other)?;
    }
    Ok((bytes, sha256))
}

fn check_transfer_cancellation(
    cancellation: Option<&ConnectionCancellation>,
) -> Result<(), SshError> {
    if cancellation.is_some_and(ConnectionCancellation::is_cancelled) {
        Err(SshError::TransferCancelled)
    } else {
        Ok(())
    }
}

fn join_remote_path(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", directory.trim_end_matches('/'))
    }
}

fn validate_remote_entry_name(name: &str, path: &str) -> Result<(), SshError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        Err(SshError::UnsupportedTransferEntry {
            path: path.to_owned(),
        })
    } else {
        Ok(())
    }
}

async fn hash_local_file(
    path: &Path,
    cancellation: Option<&ConnectionCancellation>,
) -> Result<TransferSummary, SshError> {
    check_transfer_cancellation(cancellation)?;
    let mut file = File::open(path).await?;
    let mut sink = tokio::io::sink();
    let started_at = Instant::now();
    let (bytes, sha256) =
        copy_and_hash_with_cancellation(&mut file, &mut sink, cancellation).await?;
    Ok(transfer_summary(bytes, sha256, started_at))
}

fn verify_transfer_integrity(
    expected: &TransferSummary,
    actual: &TransferSummary,
) -> Result<(), SshError> {
    if expected.bytes == actual.bytes && expected.sha256 == actual.sha256 {
        return Ok(());
    }
    Err(SshError::TransferIntegrityMismatch {
        expected: expected.sha256.clone(),
        actual: actual.sha256.clone(),
    })
}

#[cfg(windows)]
async fn publish_local_file(temporary_path: &Path, target_path: &Path) -> Result<(), SshError> {
    let temporary_path = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target_path = target_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileW(
            PCWSTR(temporary_path.as_ptr()),
            PCWSTR(target_path.as_ptr()),
        )
    }
    .map_err(|error| {
        let os_error = (error.code().0 as u32 & 0xffff) as i32;
        map_local_publish_error(io::Error::from_raw_os_error(os_error))
    })
}

#[cfg(not(windows))]
async fn publish_local_file(temporary_path: &Path, target_path: &Path) -> Result<(), SshError> {
    fs::hard_link(temporary_path, target_path)
        .await
        .map_err(map_local_publish_error)?;
    let _ = fs::remove_file(temporary_path).await;
    Ok(())
}

async fn publish_local_file_with_conflict(
    temporary_path: &Path,
    target_path: &Path,
    conflict_action: SftpConflictAction,
) -> Result<(), SshError> {
    let Some(metadata) = local_entry_metadata(target_path).await? else {
        return publish_local_file(temporary_path, target_path).await;
    };
    if conflict_action != SftpConflictAction::Overwrite
        || !(metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err(SshError::LocalTargetExists);
    }

    let backup_path = temporary_local_backup_path(target_path)?;
    fs::rename(target_path, &backup_path).await?;
    if let Err(publish_error) = publish_local_file(temporary_path, target_path).await {
        return match fs::rename(&backup_path, target_path).await {
            Ok(()) => Err(publish_error),
            Err(restore_error) => Err(SshError::TransferCleanupFailed {
                transfer: publish_error.to_string(),
                cleanup: restore_error.to_string(),
            }),
        };
    }
    fs::remove_file(&backup_path)
        .await
        .map_err(|error| SshError::TransferCleanupFailed {
            transfer: "local replacement was published".to_owned(),
            cleanup: error.to_string(),
        })?;
    Ok(())
}

fn map_local_publish_error(error: io::Error) -> SshError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        SshError::LocalTargetExists
    } else {
        SshError::TransferIo(error)
    }
}

fn map_local_directory_create_error(error: io::Error) -> SshError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        SshError::LocalTargetExists
    } else {
        SshError::TransferIo(error)
    }
}

async fn cleanup_local_entries(created: &CreatedLocalEntries) -> Result<(), SshError> {
    let mut first_error = None;
    for path in created.files.iter().rev() {
        if let Err(error) = fs::remove_file(path).await {
            first_error.get_or_insert(SshError::from(error));
        }
    }
    for path in created.directories.iter().rev() {
        if let Err(error) = fs::remove_dir(path).await {
            first_error.get_or_insert(SshError::from(error));
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn validate_remote_path(path: &str) -> Result<&str, SshError> {
    if path.trim().is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || path.split('/').any(|component| component == "..")
    {
        Err(SshError::InvalidRemotePath)
    } else {
        Ok(path)
    }
}

fn validate_mutation_path(path: &str) -> Result<&str, SshError> {
    let path = validate_remote_path(path)?;
    if !path.starts_with('/')
        || path == "/"
        || path.ends_with('/')
        || path
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        Err(SshError::InvalidRemotePath)
    } else {
        Ok(path)
    }
}

fn normalize_remote_path(path: String) -> String {
    path.replace('\\', "/")
}

fn is_remote_descendant(parent: &str, path: &str) -> bool {
    path.strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_remote_permissions(permissions: u32) -> Result<(), SshError> {
    if permissions <= 0o7777 {
        Ok(())
    } else {
        Err(SshError::InvalidRemotePermissions)
    }
}

async fn local_entry_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, SshError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn reject_local_symlink_components(path: &Path, include_leaf: bool) -> Result<(), SshError> {
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() && (include_leaf || ancestor != path) {
            return Err(SshError::UnsupportedTransferEntry {
                path: ancestor.to_string_lossy().into_owned(),
            });
        }
    }
    Ok(())
}

async fn resolve_local_file_target(
    path: &Path,
    conflict_action: SftpConflictAction,
) -> Result<Option<PathBuf>, SshError> {
    let Some(metadata) = local_entry_metadata(path).await? else {
        return Ok(Some(path.to_owned()));
    };
    match conflict_action {
        SftpConflictAction::Ask => Err(SshError::LocalTargetExists),
        SftpConflictAction::Skip => Ok(None),
        SftpConflictAction::Overwrite => {
            if metadata.is_file() || metadata.file_type().is_symlink() {
                Ok(Some(path.to_owned()))
            } else {
                Err(SshError::LocalTargetExists)
            }
        }
        SftpConflictAction::Rename => Ok(Some(unique_local_path(path).await?)),
    }
}

async fn resolve_local_directory_target(
    path: &Path,
    conflict_action: SftpConflictAction,
) -> Result<Option<(PathBuf, bool)>, SshError> {
    let Some(metadata) = local_entry_metadata(path).await? else {
        return Ok(Some((path.to_owned(), true)));
    };
    match conflict_action {
        SftpConflictAction::Ask => Err(SshError::LocalTargetExists),
        SftpConflictAction::Skip => Ok(None),
        SftpConflictAction::Overwrite => {
            if metadata.is_dir() {
                Ok(Some((path.to_owned(), false)))
            } else {
                Err(SshError::LocalTargetExists)
            }
        }
        SftpConflictAction::Rename => Ok(Some((unique_local_path(path).await?, true))),
    }
}

async fn unique_local_path(path: &Path) -> Result<PathBuf, SshError> {
    for index in 1..=10_000 {
        let candidate = path.with_file_name(auto_rename_name(
            &path
                .file_name()
                .ok_or(SshError::InvalidLocalFile)?
                .to_string_lossy(),
            index,
        ));
        if local_entry_metadata(&candidate).await?.is_none() {
            return Ok(candidate);
        }
    }
    Err(SshError::LocalTargetExists)
}

fn auto_rename_name(name: &str, index: u32) -> String {
    if let Some((stem, extension)) = name.rsplit_once('.') {
        if !stem.is_empty() {
            return format!("{stem} ({index}).{extension}");
        }
    }
    format!("{name} ({index})")
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

fn temporary_remote_backup_path(remote_path: &str) -> String {
    format!(
        "{remote_path}.bx-ssh-backup-{}-{}",
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

fn temporary_local_backup_path(local_path: &Path) -> Result<PathBuf, SshError> {
    let file_name = local_path
        .file_name()
        .ok_or(SshError::InvalidLocalFile)?
        .to_string_lossy();
    let backup_name = format!(
        ".{file_name}.bx-ssh-backup-{}-{}",
        std::process::id(),
        TEMPORARY_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    Ok(local_path.with_file_name(backup_name))
}

fn transfer_summary(bytes: u64, sha256: String, started_at: Instant) -> TransferSummary {
    let elapsed = started_at.elapsed();
    let elapsed_ms = elapsed.as_millis().max(1).min(u128::from(u64::MAX)) as u64;
    let bytes_per_second = transfer_rate(bytes, elapsed_ms);
    TransferSummary {
        bytes,
        elapsed_ms,
        bytes_per_second,
        sha256,
    }
}

fn batch_summary(
    files: u64,
    directories: u64,
    bytes: u64,
    started_at: Instant,
) -> TransferBatchSummary {
    let elapsed_ms = started_at
        .elapsed()
        .as_millis()
        .max(1)
        .min(u128::from(u64::MAX)) as u64;
    let bytes_per_second = transfer_rate(bytes, elapsed_ms);
    TransferBatchSummary {
        files,
        directories,
        bytes,
        elapsed_ms,
        bytes_per_second,
    }
}

fn transfer_rate(bytes: u64, elapsed_ms: u64) -> u64 {
    let rate = (u128::from(bytes) * 1000) / u128::from(elapsed_ms.max(1));
    rate.min(u128::from(u64::MAX)) as u64
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
    use std::io::Cursor;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    use bx_contracts::{RemoteFileKind, SftpConflictAction, TransferSummary};
    use tokio::fs;
    use tokio::io;
    use tokio::time::{timeout, Duration};

    use super::{
        auto_rename_name, copy_and_hash_with_cancellation, copy_and_hash_with_progress,
        file_kind_order, join_remote_path, publish_local_file, publish_local_file_with_conflict,
        resolve_local_directory_target, resolve_local_file_target, sftp_config,
        temporary_local_path, validate_mutation_path, validate_remote_entry_name,
        validate_remote_path, validate_remote_permissions, verify_transfer_integrity,
    };
    use crate::{ConnectionCancellation, SshError};

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
        assert!(matches!(
            validate_remote_path("/home/bx/../outside"),
            Err(SshError::InvalidRemotePath)
        ));
        assert!(matches!(
            validate_remote_path("/home/bx\\outside"),
            Err(SshError::InvalidRemotePath)
        ));
        assert!(validate_remote_path("./release.zip").is_ok());
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

        assert_eq!(config.max_packet_len, 64 * 1024);
        assert_eq!(config.max_concurrent_writes, 64);
        assert_eq!(config.request_timeout_secs, 30);
    }

    #[test]
    fn accepts_matching_integrity_and_rejects_mismatches() {
        let expected = transfer_summary(12, "abc");
        assert!(verify_transfer_integrity(&expected, &expected).is_ok());

        let error = verify_transfer_integrity(&expected, &transfer_summary(12, "def"))
            .expect_err("different checksums must fail validation");
        assert!(matches!(error, SshError::TransferIntegrityMismatch { .. }));
    }

    #[test]
    fn cancels_transfer_before_starting_and_joins_remote_paths_safely() {
        let cancellation = ConnectionCancellation::default();
        assert!(!cancellation.is_cancelled());
        cancellation.cancel();
        assert!(cancellation.is_cancelled());
        assert_eq!(
            join_remote_path("/home/bx", "release.zip"),
            "/home/bx/release.zip"
        );
        assert_eq!(join_remote_path("/", "release.zip"), "/release.zip");
        assert!(validate_remote_entry_name("release.zip", "/release.zip").is_ok());
        assert!(validate_remote_entry_name("../escape", "/../escape").is_err());
        assert!(validate_remote_entry_name("nested/file", "/nested/file").is_err());
    }

    #[tokio::test]
    async fn cancels_a_transfer_while_waiting_for_io() {
        let (_writer, mut reader) = io::duplex(1);
        let mut sink = io::sink();
        let cancellation = ConnectionCancellation::default();
        let cancellation_request = cancellation.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            cancellation_request.cancel();
        });

        let error = timeout(
            Duration::from_secs(1),
            copy_and_hash_with_cancellation(&mut reader, &mut sink, Some(&cancellation)),
        )
        .await
        .expect("cancelled transfer must wake promptly")
        .expect_err("cancelled transfer must not finish successfully");
        assert!(matches!(error, SshError::TransferCancelled));
    }

    #[tokio::test]
    async fn publishes_progress_after_each_written_chunk() {
        let data = vec![0x5a; super::TRANSFER_BUFFER_BYTES * 2 + 17];
        let mut reader = Cursor::new(data.clone());
        let mut sink = io::sink();
        let mut progress = Vec::new();
        let (bytes, _) =
            copy_and_hash_with_progress(&mut reader, &mut sink, None, &mut |transferred| {
                progress.push(transferred)
            })
            .await
            .expect("copy must succeed");

        assert_eq!(bytes, data.len() as u64);
        assert_eq!(
            progress,
            vec![
                super::TRANSFER_BUFFER_BYTES as u64,
                (super::TRANSFER_BUFFER_BYTES * 2) as u64,
                data.len() as u64,
            ]
        );
    }

    #[test]
    fn batch_summaries_keep_directory_and_file_counts() {
        let summary = super::batch_summary(3, 4, 1024, std::time::Instant::now());
        assert_eq!(summary.files, 3);
        assert_eq!(summary.directories, 4);
        assert_eq!(summary.bytes, 1024);
        assert!(summary.elapsed_ms >= 1);
    }

    #[test]
    fn keeps_large_transfer_rates_bounded() {
        let one_gib = 1024_u64 * 1024 * 1024;
        let rate = super::transfer_rate(one_gib, 1_000);

        assert_eq!(rate, one_gib);
        assert_eq!(super::transfer_rate(u64::MAX, 1), u64::MAX);
        assert_eq!(super::transfer_rate(1, 0), 1_000);
    }

    #[test]
    fn validates_remote_mutation_paths_and_permissions() {
        assert_eq!(
            validate_mutation_path("/home/bx/new").unwrap(),
            "/home/bx/new"
        );
        for path in [
            ".",
            "relative",
            "/",
            "/home/bx/",
            "/home/../escape",
            "/home//file",
        ] {
            assert!(matches!(
                validate_mutation_path(path),
                Err(SshError::InvalidRemotePath)
            ));
        }
        assert!(validate_remote_permissions(0o7777).is_ok());
        assert!(matches!(
            validate_remote_permissions(0o10000),
            Err(SshError::InvalidRemotePermissions)
        ));
    }

    #[test]
    fn builds_stable_auto_rename_names() {
        assert_eq!(auto_rename_name("archive.tar", 1), "archive (1).tar");
        assert_eq!(auto_rename_name("README", 2), "README (2)");
        assert_eq!(auto_rename_name(".env", 3), ".env (3)");
    }

    #[tokio::test]
    async fn resolves_local_conflicts_without_touching_existing_targets() {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "bx-ssh-conflict-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).await.unwrap();
        let file = directory.join("notes.txt");
        fs::write(&file, b"original").await.unwrap();

        assert!(resolve_local_file_target(&file, SftpConflictAction::Skip)
            .await
            .unwrap()
            .is_none());
        assert!(resolve_local_file_target(&file, SftpConflictAction::Ask)
            .await
            .is_err());
        assert_eq!(
            resolve_local_file_target(&file, SftpConflictAction::Overwrite)
                .await
                .unwrap()
                .unwrap(),
            file
        );
        let renamed = resolve_local_file_target(&file, SftpConflictAction::Rename)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(renamed.file_name().unwrap(), "notes (1).txt");

        let directory_target = directory.join("folder");
        fs::create_dir(&directory_target).await.unwrap();
        let (merged, created) =
            resolve_local_directory_target(&directory_target, SftpConflictAction::Overwrite)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(merged, directory_target);
        assert!(!created);
        assert!(
            resolve_local_directory_target(&file, SftpConflictAction::Overwrite)
                .await
                .is_err()
        );

        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn publishes_local_downloads_without_overwriting_an_existing_target() {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "bx-ssh-publish-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).await.unwrap();
        let target = directory.join("archive.tar");
        let temporary = temporary_local_path(&target).unwrap();
        fs::write(&temporary, b"verified").await.unwrap();

        publish_local_file(&temporary, &target).await.unwrap();
        assert_eq!(fs::read(&target).await.unwrap(), b"verified");
        assert!(!fs::try_exists(&temporary).await.unwrap());

        let conflicting_temporary = temporary_local_path(&target).unwrap();
        fs::write(&conflicting_temporary, b"replacement")
            .await
            .unwrap();
        let error = publish_local_file(&conflicting_temporary, &target)
            .await
            .expect_err("publishing must not replace an existing target");
        assert!(matches!(error, SshError::LocalTargetExists));
        assert_eq!(fs::read(&target).await.unwrap(), b"verified");

        fs::remove_file(&conflicting_temporary).await.unwrap();
        fs::remove_file(&target).await.unwrap();
        fs::remove_dir(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn replaces_local_downloads_without_leaving_the_old_target_unprotected() {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "bx-ssh-overwrite-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).await.unwrap();
        let target = directory.join("archive.tar");
        let temporary = temporary_local_path(&target).unwrap();
        fs::write(&target, b"original").await.unwrap();
        fs::write(&temporary, b"replacement").await.unwrap();

        publish_local_file_with_conflict(&temporary, &target, SftpConflictAction::Overwrite)
            .await
            .unwrap();

        assert_eq!(fs::read(&target).await.unwrap(), b"replacement");
        assert!(!fs::try_exists(&temporary).await.unwrap());
        let mut entries = fs::read_dir(&directory).await.unwrap();
        assert_eq!(entries.next_entry().await.unwrap().unwrap().path(), target);
        assert!(entries.next_entry().await.unwrap().is_none());

        fs::remove_file(&target).await.unwrap();
        fs::remove_dir(&directory).await.unwrap();
    }

    fn transfer_summary(bytes: u64, sha256: &str) -> TransferSummary {
        TransferSummary {
            bytes,
            elapsed_ms: 1,
            bytes_per_second: bytes * 1000,
            sha256: sha256.to_owned(),
        }
    }
}
