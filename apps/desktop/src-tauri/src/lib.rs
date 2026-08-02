use bx_contracts::AppInfo;

mod terminal;

use terminal::{
    close_terminal_session, probe_ssh_host, resize_terminal, start_password_shell, write_terminal,
    TerminalSessionManager,
};

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo::new("BX SSH", env!("CARGO_PKG_VERSION"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalSessionManager::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            probe_ssh_host,
            start_password_shell,
            write_terminal,
            resize_terminal,
            close_terminal_session
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
