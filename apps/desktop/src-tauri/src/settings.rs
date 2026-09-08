use bx_contracts::{ApplicationSettings, ConnectionSettings, GlobalSettingsSnapshot};
use tauri::{AppHandle, State};

use crate::command_error::CommandError;
use crate::connections::{
    app_data_directory, current_timestamp_ms, run_query, ConnectionRepositoryState,
};

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_global_settings(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
) -> Result<GlobalSettingsSnapshot, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let settings = run_query(state.inner().clone(), data_directory, |repository| {
        repository.get_global_settings()
    })
    .await?;
    crate::logging::set_level(settings.application.log_level);
    Ok(settings)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_global_settings(
    app: AppHandle,
    state: State<'_, ConnectionRepositoryState>,
    application: ApplicationSettings,
    connection: ConnectionSettings,
) -> Result<GlobalSettingsSnapshot, CommandError> {
    let data_directory = app_data_directory(&app)?;
    let now_ms = current_timestamp_ms()?;
    let settings = run_query(state.inner().clone(), data_directory, move |repository| {
        repository.save_global_settings(&application, connection, now_ms)
    })
    .await?;
    crate::logging::set_level(settings.application.log_level);
    Ok(settings)
}
