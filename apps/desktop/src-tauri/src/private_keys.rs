use std::fs;
use std::io::Read;

use std::path::Path;

use bx_contracts::{
    PrivateKeyMetadata, PrivateKeyReferenceRequest, PrivateKeyStorageKind, PrivateKeySummary,
    SensitiveString,
};
use bx_persistence::{
    CredentialStore, EncryptedPrivateKey, ExposeSecret, SecretCredentialStore, SecretSlice,
    SecretString, SystemCredentialStore,
};
use bx_ssh_core::inspect_private_key;
use secrecy::zeroize::{Zeroize, Zeroizing};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::command_error::{CommandError, CommandErrorCode};
use crate::connections::{app_data_directory, run_query, ConnectionRepositoryState};

pub(crate) const PRIVATE_KEY_MATERIAL_SERVICE: &str = "bx-ssh-private-key-material";
pub(crate) const PRIVATE_KEY_PASSPHRASE_SERVICE: &str = "bx-ssh-private-key-passphrase";
const MAX_PRIVATE_KEY_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub(crate) async fn list_private_keys(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
) -> Result<Vec<PrivateKeySummary>, CommandError> {
    let data_directory = app_data_directory(&app)?;
    run_query(state.inner().clone(), data_directory, |repository| {
        repository.list_private_key_summaries()
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn inspect_private_key_file(
    path: String,
    passphrase: Option<SensitiveString>,
) -> Result<PrivateKeyMetadata, CommandError> {
    let path = validate_private_key_path(&path)?;
    let contents = read_private_key_contents(path)?;
    let passphrase = passphrase.as_ref().map(SensitiveString::as_str);
    inspect_private_key(contents.expose_secret(), passphrase)
        .map_err(|error| CommandError::from_ssh(&error))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_private_key_reference(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    request: PrivateKeyReferenceRequest,
    passphrase: Option<SensitiveString>,
) -> Result<PrivateKeySummary, CommandError> {
    let path = request
        .file_path
        .as_deref()
        .ok_or_else(|| private_key_error("the private key file path is required"))?;
    let path = validate_private_key_path(path)?;
    let path_string = path.to_string_lossy().into_owned();
    let contents = read_private_key_contents(path)?;
    let passphrase_ref = passphrase.as_ref().map(SensitiveString::as_str);
    let metadata = inspect_private_key(contents.expose_secret(), passphrase_ref)
        .map_err(|error| CommandError::from_ssh(&error))?;
    let id = Uuid::new_v4().to_string();
    let (file_path, encrypted_material, material_key_ref, credential_cleanup) =
        match request.storage_kind {
            PrivateKeyStorageKind::File => (Some(path_string), None, None, None),
            PrivateKeyStorageKind::Imported => {
                let plaintext = SecretSlice::from(contents.expose_secret().as_bytes().to_vec());
                let (encrypted, data_key) = EncryptedPrivateKey::encrypt(&plaintext)?;
                let key_ref = id.clone();
                let store = SystemCredentialStore::new(PRIVATE_KEY_MATERIAL_SERVICE, &key_ref)?;
                store.save_data_key(&data_key)?;
                (
                    None,
                    Some(encrypted.to_bytes()),
                    Some(key_ref.clone()),
                    Some(key_ref),
                )
            }
        };
    let data_directory = app_data_directory(&app)?;
    let now_ms = crate::connections::current_timestamp_ms()?;
    let result = run_query(state.inner().clone(), data_directory, {
        let request = request.clone();
        let id = id.clone();
        let algorithm = metadata.public_key_algorithm.clone();
        let fingerprint = metadata.fingerprint_sha256.clone();
        move |repository| {
            repository.insert_private_key_reference(
                &id,
                &request.name,
                request.storage_kind,
                file_path.as_deref(),
                encrypted_material.as_deref(),
                material_key_ref.as_deref(),
                None,
                &algorithm,
                &fingerprint,
                request.comment.as_deref(),
                now_ms,
            )?;
            repository
                .list_private_key_summaries()?
                .into_iter()
                .find(|summary| summary.id == id)
                .ok_or(bx_persistence::PersistenceError::InvalidStoredRecord {
                    entity: "private key",
                })
        }
    })
    .await;
    if result.is_err() {
        if let Some(key_ref) = credential_cleanup {
            if let Ok(store) = SystemCredentialStore::new(PRIVATE_KEY_MATERIAL_SERVICE, &key_ref) {
                let _ = store.delete_data_key();
            }
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_private_key_reference(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
) -> Result<bool, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let reference = run_query(state.inner().clone(), data_directory.clone(), {
        let id = id.clone();
        move |repository| repository.get_private_key_reference(&id)
    })
    .await?
    .ok_or_else(|| private_key_error("the private key reference was not found"))?;
    let deleted = run_query(state.inner().clone(), data_directory, move |repository| {
        repository.delete_private_key_reference(&id)
    })
    .await?;
    if deleted {
        if let Some(key_ref) = reference.material_key_ref.as_deref() {
            let store = SystemCredentialStore::new(PRIVATE_KEY_MATERIAL_SERVICE, key_ref)?;
            store.delete_data_key()?;
        }
    }
    Ok(deleted)
}

fn validate_private_key_path(path: &str) -> Result<&Path, CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(private_key_error("the private key file path is required"));
    }
    Ok(Path::new(trimmed))
}

pub(crate) struct ResolvedPrivateKey {
    pub(crate) contents: SecretString,
    pub(crate) passphrase: Option<SecretString>,
}

pub(crate) async fn resolve_private_key(
    app: &AppHandle,
    state: &State<'_, ConnectionRepositoryState>,
    id: &str,
    supplied_passphrase: Option<SensitiveString>,
) -> Result<ResolvedPrivateKey, CommandError> {
    let data_directory = app_data_directory(app)?;
    let reference = run_query(state.inner().clone(), data_directory, {
        let id = id.to_owned();
        move |repository| repository.get_private_key_reference(&id)
    })
    .await?
    .ok_or_else(|| private_key_error("the private key reference was not found"))?;

    let contents = match reference.storage_kind.as_str() {
        "file" => {
            let path = reference
                .file_path
                .as_deref()
                .ok_or_else(|| private_key_error("the private key file reference is invalid"))?;
            read_private_key_contents(Path::new(path))?
        }
        "imported" => {
            let encrypted = reference
                .encrypted_material
                .as_deref()
                .ok_or_else(|| private_key_error("the imported private key record is invalid"))?;
            let material_key_ref = reference.material_key_ref.as_deref().ok_or_else(|| {
                private_key_error("the imported private key key reference is invalid")
            })?;
            let store = SystemCredentialStore::new(PRIVATE_KEY_MATERIAL_SERVICE, material_key_ref)
                .map_err(|_| private_key_error("the private key data key is unavailable"))?;
            let data_key = store
                .load_data_key()
                .map_err(|_| private_key_error("the private key data key is unavailable"))?
                .ok_or_else(|| private_key_error("the private key data key is unavailable"))?;
            let encrypted = EncryptedPrivateKey::from_bytes(encrypted)
                .map_err(|_| private_key_error("the imported private key record is invalid"))?;
            let decrypted = encrypted.decrypt(&data_key).map_err(|_| {
                private_key_error("the imported private key could not be decrypted")
            })?;
            secret_string_from_bytes(Zeroizing::new(decrypted.expose_secret().to_vec()))?
        }
        _ => return Err(private_key_error("the private key storage type is invalid")),
    };

    let passphrase = match supplied_passphrase {
        Some(value) => Some(SecretString::from(value.into_inner())),
        None => reference
            .passphrase_credential_ref
            .as_deref()
            .map(|credential_ref| {
                SystemCredentialStore::new(PRIVATE_KEY_PASSPHRASE_SERVICE, credential_ref)
                    .map_err(|_| {
                        private_key_error("the private key passphrase store is unavailable")
                    })?
                    .load_secret()
                    .map_err(|_| private_key_error("the private key passphrase could not be read"))
            })
            .transpose()?
            .flatten(),
    };

    Ok(ResolvedPrivateKey {
        contents,
        passphrase,
    })
}

/// Read private-key text into a zeroizing secret value without exposing a
/// plaintext `String` to the surrounding command code. Invalid UTF-8 bytes
/// are explicitly cleared before the error is discarded.
fn read_private_key_contents(path: &Path) -> Result<SecretString, CommandError> {
    let metadata = fs::metadata(path)
        .map_err(|_| private_key_error("the private key file could not be read"))?;
    if !metadata.is_file() || metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err(private_key_error(
            "the private key file is too large or is not a regular file",
        ));
    }

    let mut file = fs::File::open(path)
        .map_err(|_| private_key_error("the private key file could not be read"))?;
    let capacity = usize::try_from(metadata.len()).unwrap_or(0);
    let mut bytes = Zeroizing::new(Vec::with_capacity(capacity));
    file.by_ref()
        .take(MAX_PRIVATE_KEY_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| private_key_error("the private key file could not be read"))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_PRIVATE_KEY_BYTES {
        return Err(private_key_error(
            "the private key file is too large or is not a regular file",
        ));
    }
    secret_string_from_bytes(bytes)
}

fn secret_string_from_bytes(mut bytes: Zeroizing<Vec<u8>>) -> Result<SecretString, CommandError> {
    let raw = std::mem::take(&mut *bytes);
    match String::from_utf8(raw) {
        Ok(value) => Ok(SecretString::from(value)),
        Err(error) => {
            let mut invalid_bytes = error.into_bytes();
            invalid_bytes.zeroize();
            Err(private_key_error("the private key is not valid UTF-8 text"))
        }
    }
}

fn private_key_error(message: &'static str) -> CommandError {
    CommandError::new(CommandErrorCode::PrivateKeyError, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_private_key_bytes_into_a_redacted_secret() {
        let secret = secret_string_from_bytes(Zeroizing::new(
            b"-----BEGIN OPENSSH PRIVATE KEY-----".to_vec(),
        ))
        .unwrap();

        assert_eq!(
            secret.expose_secret(),
            "-----BEGIN OPENSSH PRIVATE KEY-----"
        );
        assert!(!format!("{secret:?}").contains("BEGIN OPENSSH"));
    }

    #[test]
    fn rejects_invalid_utf8_without_returning_the_secret_bytes() {
        let error = secret_string_from_bytes(Zeroizing::new(vec![0xff, 0xfe])).unwrap_err();

        assert_eq!(error.code, CommandErrorCode::PrivateKeyError);
        assert_eq!(error.message, "the private key is not valid UTF-8 text");
        assert!(!format!("{error:?}").contains("255"));
    }
}
