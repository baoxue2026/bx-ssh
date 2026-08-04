use bx_contracts::AppInfo;
#[cfg(any(debug_assertions, test))]
use bx_contracts::{
    ConnectionConfig, ConnectionSettings, ConnectionSettingsLayers, ConnectionSettingsScope,
};
#[cfg(any(debug_assertions, test))]
use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;
#[cfg(any(debug_assertions, test))]
use tauri_specta::{collect_commands, Builder};

mod command_error;
mod connections;
mod desktop_shell;
mod lifecycle;
mod platform;
mod sftp;
mod terminal;
mod update;

use connections::{get_connection, list_connections, ConnectionRepositoryState};
#[cfg(any(debug_assertions, test))]
use desktop_shell::AppMenuAction;
use lifecycle::{confirm_app_exit, AppActivity, ExitCoordinator, ExitImpact, EXIT_REQUESTED_EVENT};
use platform::set_webview_memory_usage;
use sftp::{
    close_sftp_session, download_sftp_file, hash_remote_sftp_file, list_sftp_directory,
    start_password_sftp, upload_sftp_file, SftpSessionManager,
};
use terminal::{
    acknowledge_terminal_output, close_terminal_session, probe_ssh_host, resize_terminal,
    start_password_shell, write_terminal, TerminalSessionManager,
};
use update::{check_for_update, install_update};

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the e2e feature must never be enabled in release builds");

#[tauri::command]
#[specta::specta]
fn app_info() -> AppInfo {
    AppInfo::new("BX SSH", env!("CARGO_PKG_VERSION"))
}

#[cfg(any(debug_assertions, test))]
fn command_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            app_info,
            terminal::probe_ssh_host,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::acknowledge_terminal_output,
            terminal::close_terminal_session,
            sftp::start_password_sftp,
            sftp::list_sftp_directory,
            sftp::upload_sftp_file,
            sftp::download_sftp_file,
            sftp::hash_remote_sftp_file,
            sftp::close_sftp_session,
            platform::set_webview_memory_usage,
            update::check_for_update,
            lifecycle::confirm_app_exit,
            connections::list_connections,
            connections::get_connection
        ])
        .typ::<terminal::StartShellRequest>()
        .typ::<terminal::StartShellResponse>()
        .typ::<terminal::TerminalEvent>()
        .typ::<update::UpdateEvent>()
        .typ::<AppMenuAction>()
        .typ::<ExitImpact>()
        .typ::<ConnectionConfig>()
        .typ::<ConnectionSettings>()
        .typ::<ConnectionSettingsLayers>()
        .typ::<ConnectionSettingsScope>()
}

fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

fn pending_exit_impact<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> Option<ExitImpact> {
    if manager.state::<ExitCoordinator>().is_approved() {
        return None;
    }

    let impact = manager.state::<AppActivity>().snapshot();
    impact.requires_confirmation().then_some(impact)
}

#[cfg(any(debug_assertions, test))]
fn export_typescript_bindings() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/bindings.ts");
    command_builder()
        .export(
            Typescript::default()
                .header("/* eslint-disable */\n// @ts-nocheck")
                .bigint(BigIntExportBehavior::Number),
            path,
        )
        .expect("failed to export TypeScript IPC bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    export_typescript_bindings();

    let activity = AppActivity::default();
    let terminal_manager = TerminalSessionManager::with_activity(activity.clone());
    let sftp_manager = SftpSessionManager::with_activity(activity.clone());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(desktop_shell::application_menu)
        .on_menu_event(desktop_shell::handle_menu_event)
        .on_tray_icon_event(desktop_shell::handle_tray_event)
        .setup(|app| {
            desktop_shell::setup_tray(app.handle())?;
            Ok(())
        });
    #[cfg(all(feature = "e2e", debug_assertions))]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .manage(activity)
        .manage(ExitCoordinator::default())
        .manage(terminal_manager)
        .manage(sftp_manager)
        .manage(ConnectionRepositoryState::default())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(impact) = pending_exit_impact(window) {
                    api.prevent_close();
                    let _ = window.emit(EXIT_REQUESTED_EVENT, impact);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            probe_ssh_host,
            start_password_shell,
            write_terminal,
            resize_terminal,
            acknowledge_terminal_output,
            close_terminal_session,
            start_password_sftp,
            list_sftp_directory,
            upload_sftp_file,
            download_sftp_file,
            hash_remote_sftp_file,
            close_sftp_session,
            set_webview_memory_usage,
            check_for_update,
            install_update,
            confirm_app_exit,
            list_connections,
            get_connection
        ])
        .build(tauri::generate_context!())
        .expect("failed to build BX SSH")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Some(impact) = pending_exit_impact(app) {
                    api.prevent_exit();
                    let _ = app.emit_to("main", EXIT_REQUESTED_EVENT, impact);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{app_info, export_typescript_bindings, window_state_flags};
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn reports_workspace_version() {
        let info = app_info();

        assert_eq!(info.name, "BX SSH");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn persists_only_reviewed_window_state() {
        let flags = window_state_flags();

        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags
            .intersects(StateFlags::VISIBLE | StateFlags::DECORATIONS | StateFlags::FULLSCREEN));
    }

    #[test]
    #[ignore = "writes the generated frontend IPC bindings"]
    fn exports_typescript_bindings() {
        export_typescript_bindings();
    }
}
