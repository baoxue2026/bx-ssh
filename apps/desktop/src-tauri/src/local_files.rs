use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use bx_contracts::{LocalDirectoryListing, LocalFileEntry, LocalFileKind};
use serde::Deserialize;
use specta::Type;
use tauri::command;
use tokio::fs;

use crate::command_error::{CommandError, CommandErrorCode};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalPathRequest {
    path: String,
}

#[command]
#[specta::specta]
pub(crate) async fn list_local_directory(
    request: LocalPathRequest,
) -> Result<LocalDirectoryListing, CommandError> {
    let path = canonical_directory(&request.path).await?;
    let mut entries = Vec::new();
    let mut reader = fs::read_dir(&path).await.map_err(map_local_io)?;

    while let Some(entry) = reader.next_entry().await.map_err(map_local_io)? {
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path)
            .await
            .map_err(map_local_io)?;
        entries.push(local_file_entry(&entry_path, &metadata)?);
    }

    entries.sort_by(|left, right| {
        local_file_kind_order(left.kind)
            .cmp(&local_file_kind_order(right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });

    let parent_path = path
        .parent()
        .and_then(|parent| (parent != path.as_path()).then_some(parent))
        .map(path_to_string)
        .transpose()?;

    Ok(LocalDirectoryListing {
        path: path_to_string(&path)?,
        parent_path,
        entries,
    })
}

#[command]
#[specta::specta]
pub(crate) async fn stat_local_path(
    request: LocalPathRequest,
) -> Result<LocalFileEntry, CommandError> {
    let path = validate_local_path(&request.path)?;
    reject_symlink_components(&path, false).await?;
    let metadata = fs::symlink_metadata(&path).await.map_err(map_local_io)?;
    local_file_entry(&path, &metadata)
}

async fn canonical_directory(raw_path: &str) -> Result<PathBuf, CommandError> {
    let path = validate_local_path(raw_path)?;
    reject_symlink_components(&path, true).await?;
    let path = fs::canonicalize(path).await.map_err(map_local_io)?;
    let metadata = fs::metadata(&path).await.map_err(map_local_io)?;
    if !metadata.is_dir() {
        return Err(CommandError::local_path(
            CommandErrorCode::LocalPathNotDirectory,
            "local path is not a directory",
        ));
    }
    Ok(path)
}

async fn reject_symlink_components(path: &Path, include_leaf: bool) -> Result<(), CommandError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor).await {
            Ok(metadata)
                if metadata.file_type().is_symlink() && (include_leaf || ancestor != path) =>
            {
                return Err(CommandError::local_path(
                    CommandErrorCode::InvalidLocalPath,
                    "local path must not traverse a symbolic link",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(map_local_io(error)),
        }
    }
    Ok(())
}

fn validate_local_path(raw_path: &str) -> Result<PathBuf, CommandError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(CommandError::local_path(
            CommandErrorCode::InvalidLocalPath,
            "local path is empty or contains a NUL byte",
        ));
    }
    Ok(PathBuf::from(trimmed))
}

fn local_file_entry(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<LocalFileEntry, CommandError> {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs());

    Ok(LocalFileEntry {
        name,
        path: path_to_string(path)?,
        kind: local_file_kind(metadata),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        modified_at,
        readonly: metadata.permissions().readonly(),
        hidden: is_hidden(path),
    })
}

fn local_file_kind(metadata: &std::fs::Metadata) -> LocalFileKind {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        LocalFileKind::Symlink
    } else if file_type.is_dir() {
        LocalFileKind::Directory
    } else if file_type.is_file() {
        LocalFileKind::File
    } else {
        LocalFileKind::Other
    }
}

fn local_file_kind_order(kind: LocalFileKind) -> u8 {
    match kind {
        LocalFileKind::Directory => 0,
        LocalFileKind::File => 1,
        LocalFileKind::Symlink => 2,
        LocalFileKind::Other => 3,
    }
}

fn path_to_string(path: &Path) -> Result<String, CommandError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        CommandError::local_path(
            CommandErrorCode::LocalPathIoError,
            "local path is not valid Unicode",
        )
    })
}

fn map_local_io(error: io::Error) -> CommandError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => CommandErrorCode::LocalPathNotFound,
        io::ErrorKind::PermissionDenied => CommandErrorCode::LocalPathPermissionDenied,
        _ => CommandErrorCode::LocalPathIoError,
    };
    CommandError::local_path(code, error.to_string())
}

#[cfg(windows)]
fn is_hidden(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & 0x2 != 0)
        .unwrap_or_else(|_| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('.') && name != "." && name != "..")
        })
}

#[cfg(not(windows))]
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.') && name != "." && name != "..")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use bx_contracts::LocalFileKind;

    use super::{is_hidden, local_file_kind_order, validate_local_path};
    use crate::command_error::CommandErrorCode;

    #[test]
    fn validates_local_paths_without_touching_the_filesystem() {
        assert_eq!(
            validate_local_path("C:/Users/bxssh").unwrap(),
            Path::new("C:/Users/bxssh")
        );
        assert_eq!(
            validate_local_path("  ").unwrap_err().code,
            CommandErrorCode::InvalidLocalPath
        );
        assert_eq!(
            validate_local_path("bad\0path").unwrap_err().code,
            CommandErrorCode::InvalidLocalPath
        );
    }

    #[test]
    fn keeps_directory_sorting_and_hidden_file_detection_stable() {
        assert!(
            local_file_kind_order(LocalFileKind::Directory)
                < local_file_kind_order(LocalFileKind::File)
        );
        assert!(is_hidden(Path::new(".bx-ssh-test")));
        assert!(!is_hidden(Path::new("visible.txt")));
    }
}
