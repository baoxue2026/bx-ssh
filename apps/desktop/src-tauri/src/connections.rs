use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bx_contracts::{
    ConnectionCatalog, ConnectionConfig, ConnectionDetails, ConnectionGroup,
    ConnectionSettingsOverride,
};
use bx_persistence::{
    ConnectionRepository, EncryptedDatabase, PersistenceError, SecretCredentialStore,
    SystemCredentialStore,
};
use secrecy::{ExposeSecret, SecretString};
use tauri::{AppHandle, Manager, State};

use crate::command_error::{CommandError, CommandErrorCode};

const DATABASE_FILE_NAME: &str = "bx-ssh.db";
const CREDENTIAL_SERVICE: &str = "io.github.baoxue2026.bx-ssh";
const DATABASE_KEY_ACCOUNT: &str = "database-data-key-v1";
const PASSWORD_CREDENTIAL_SERVICE: &str = "io.github.baoxue2026.bx-ssh.password";

#[derive(Clone, Default)]
pub(crate) struct ConnectionRepositoryState {
    repository: Arc<Mutex<Option<ConnectionRepository>>>,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn list_connections(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
) -> Result<ConnectionCatalog, CommandError> {
    let data_directory = app_data_directory(&app)?;
    run_query(state.inner().clone(), data_directory, |repository| {
        repository.list_catalog()
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_connection(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
) -> Result<Option<ConnectionDetails>, CommandError> {
    let data_directory = app_data_directory(&app)?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.get_connection(&id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_connection(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    config: ConnectionConfig,
    settings: ConnectionSettingsOverride,
) -> Result<(), CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.save_connection(&config, settings, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_password_credential(
    credential_ref: String,
) -> Result<Option<String>, CommandError> {
    let store = password_store(&credential_ref)?;
    Ok(store
        .load_secret()?
        .map(|secret| secret.expose_secret().to_owned()))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_password_credential(
    credential_ref: String,
    password: String,
) -> Result<(), CommandError> {
    if password.is_empty() {
        return Err(PersistenceError::InvalidCredential.into());
    }
    let store = password_store(&credential_ref)?;
    store.save_secret(&SecretString::from(password))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_password_credential(credential_ref: String) -> Result<(), CommandError> {
    let store = password_store(&credential_ref)?;
    store.delete_secret()?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_connection_group(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    group: ConnectionGroup,
) -> Result<(), CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.save_group(&group, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_connection_group(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
) -> Result<bool, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.delete_group(&id, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_connection_group_collapsed(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
    is_collapsed: bool,
) -> Result<bool, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.set_group_collapsed(&id, is_collapsed, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn reorder_connection_groups(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    ids: Vec<String>,
) -> Result<(), CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.reorder_groups(&ids, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_connection_favorite(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
    is_favorite: bool,
) -> Result<bool, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.set_connection_favorite(&id, is_favorite, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn reorder_connections(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    group_id: Option<String>,
    ids: Vec<String>,
) -> Result<(), CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.reorder_connections(group_id.as_deref(), &ids, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_connection(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
) -> Result<bool, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.delete_connection(&id, now_ms)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn record_successful_connection(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    id: String,
) -> Result<bool, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    run_query(state.inner().clone(), data_directory, move |repository| {
        repository.record_successful_connection(&id, now_ms)
    })
    .await
}

pub(crate) fn app_data_directory(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path().app_data_dir().map_err(|_| {
        CommandError::new(
            CommandErrorCode::DatabaseUnavailable,
            "application data directory is unavailable",
        )
    })
}

pub(crate) fn current_timestamp_ms() -> Result<u64, CommandError> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
        CommandError::new(
            CommandErrorCode::DatabaseQueryFailed,
            "system clock is before the Unix epoch",
        )
    })?;
    u64::try_from(elapsed.as_millis()).map_err(|_| {
        CommandError::new(
            CommandErrorCode::DatabaseQueryFailed,
            "system clock value is out of range",
        )
    })
}

pub(crate) async fn run_query<T, F>(
    state: ConnectionRepositoryState,
    data_directory: PathBuf,
    query: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut ConnectionRepository) -> Result<T, PersistenceError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || state.execute(&data_directory, query))
        .await
        .map_err(|_| {
            CommandError::new(
                CommandErrorCode::DatabaseQueryFailed,
                "database query task failed",
            )
        })?
}

impl ConnectionRepositoryState {
    fn execute<T>(
        &self,
        data_directory: &Path,
        query: impl FnOnce(&mut ConnectionRepository) -> Result<T, PersistenceError>,
    ) -> Result<T, CommandError> {
        let mut repository = self.repository.lock().map_err(|_| {
            CommandError::new(
                CommandErrorCode::DatabaseUnavailable,
                "connection repository state is unavailable",
            )
        })?;
        if repository.is_none() {
            *repository = Some(initialize_repository(data_directory)?);
        }
        query(repository.as_mut().expect("repository was initialized")).map_err(Into::into)
    }
}

fn initialize_repository(data_directory: &Path) -> Result<ConnectionRepository, CommandError> {
    fs::create_dir_all(data_directory).map_err(|_| {
        CommandError::new(
            CommandErrorCode::DatabaseUnavailable,
            "application data directory could not be created",
        )
    })?;
    let credential_store = SystemCredentialStore::new(CREDENTIAL_SERVICE, DATABASE_KEY_ACCOUNT)?;
    let database = EncryptedDatabase::open_or_initialize(
        data_directory.join(DATABASE_FILE_NAME),
        &credential_store,
    )?;
    ConnectionRepository::new(database).map_err(Into::into)
}

fn password_store(credential_ref: &str) -> Result<SystemCredentialStore, CommandError> {
    let account = credential_ref.trim();
    if account.is_empty() {
        return Err(PersistenceError::InvalidCredential.into());
    }
    SystemCredentialStore::new(PASSWORD_CREDENTIAL_SERVICE, account).map_err(Into::into)
}
