use std::fs;

use bx_persistence::{
    CredentialStore, EncryptedPrivateKey, ExposeSecret, SecretCredentialStore, SecretString,
    SystemCredentialStore,
};
use tauri::{AppHandle, State};

use crate::command_error::{CommandError, CommandErrorCode};
use crate::connections::{app_data_directory, run_query, ConnectionRepositoryState};

pub(crate) const PRIVATE_KEY_MATERIAL_SERVICE: &str = "bx-ssh-private-key-material";
pub(crate) const PRIVATE_KEY_PASSPHRASE_SERVICE: &str = "bx-ssh-private-key-passphrase";

pub(crate) struct ResolvedPrivateKey {
    pub(crate) contents: SecretString,
    pub(crate) passphrase: Option<SecretString>,
}

pub(crate) async fn resolve_private_key(
    app: &AppHandle,
    state: &State<'_, ConnectionRepositoryState>,
    id: &str,
    supplied_passphrase: Option<String>,
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
            fs::read_to_string(path)
                .map_err(|_| private_key_error("the private key file could not be read"))?
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
            String::from_utf8(decrypted.expose_secret().to_vec())
                .map_err(|_| private_key_error("the imported private key is not valid text"))?
        }
        _ => return Err(private_key_error("the private key storage type is invalid")),
    };

    let passphrase = match supplied_passphrase {
        Some(value) => Some(SecretString::from(value)),
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
        contents: SecretString::from(contents),
        passphrase,
    })
}

fn private_key_error(message: &'static str) -> CommandError {
    CommandError::new(CommandErrorCode::PrivateKeyError, message)
}
