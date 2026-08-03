use bx_contracts::AppInfo;

mod command_error;
mod platform;
mod sftp;
mod terminal;
mod update;

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
fn app_info() -> AppInfo {
    AppInfo::new("BX SSH", env!("CARGO_PKG_VERSION"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(all(feature = "e2e", debug_assertions))]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .manage(TerminalSessionManager::default())
        .manage(SftpSessionManager::default())
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
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run BX SSH");
}

#[cfg(test)]
mod tests {
    use super::app_info;

    #[test]
    fn reports_workspace_version() {
        let info = app_info();

        assert_eq!(info.name, "BX SSH");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }
}
