use serde::Serialize;
use specta::Type;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::lifecycle::EXIT_REQUESTED_EVENT;
use crate::pending_exit_impact;

pub(crate) const APP_MENU_ACTION_EVENT: &str = "app-menu-action";

const MENU_TERMINAL: &str = "workspace-terminal";
const MENU_SFTP: &str = "workspace-sftp";
const MENU_CHECK_UPDATES: &str = "check-updates";
const MENU_EXIT: &str = "exit";
const TRAY_SHOW: &str = "tray-show";
const TRAY_CHECK_UPDATES: &str = "tray-check-updates";
const TRAY_EXIT: &str = "tray-exit";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AppMenuAction {
    ShowTerminal,
    ShowSftp,
    CheckForUpdates,
}

pub(crate) fn application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let exit = MenuItem::with_id(app, MENU_EXIT, "退出", true, Some("Ctrl+Shift+Q"))?;
    let file = Submenu::with_items(app, "文件", true, &[&exit])?;

    let terminal = MenuItem::with_id(app, MENU_TERMINAL, "终端", true, Some("Ctrl+1"))?;
    let sftp = MenuItem::with_id(app, MENU_SFTP, "SFTP", true, Some("Ctrl+2"))?;
    let workspace = Submenu::with_items(app, "工作区", true, &[&terminal, &sftp])?;

    let check_updates = MenuItem::with_id(
        app,
        MENU_CHECK_UPDATES,
        "检查更新",
        true,
        Some("Ctrl+Shift+U"),
    )?;
    let help = Submenu::with_items(app, "帮助", true, &[&check_updates])?;

    Menu::with_items(app, &[&file, &workspace, &help])
}

pub(crate) fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "显示 BX SSH", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, TRAY_CHECK_UPDATES, "检查更新", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, TRAY_EXIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &check_updates, &separator, &exit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("BX SSH")
        .show_menu_on_left_click(false)
        .menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let action = match event.id().as_ref() {
        MENU_TERMINAL => Some(AppMenuAction::ShowTerminal),
        MENU_SFTP => Some(AppMenuAction::ShowSftp),
        MENU_CHECK_UPDATES | TRAY_CHECK_UPDATES => Some(AppMenuAction::CheckForUpdates),
        TRAY_SHOW => {
            show_main_window(app);
            None
        }
        MENU_EXIT | TRAY_EXIT => {
            request_app_exit(app);
            None
        }
        _ => None,
    };

    if let Some(action) = action {
        show_main_window(app);
        let _ = app.emit_to("main", APP_MENU_ACTION_EVENT, action);
    }
}

pub(crate) fn handle_tray_event<R: Runtime>(app: &AppHandle<R>, event: TrayIconEvent) {
    if matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    ) {
        show_main_window(app);
    }
}

fn request_app_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(impact) = pending_exit_impact(app) {
        show_main_window(app);
        let _ = app.emit_to("main", EXIT_REQUESTED_EVENT, impact);
    } else {
        app.exit(0);
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::AppMenuAction;

    #[test]
    fn serializes_menu_actions_as_stable_event_values() {
        assert_eq!(
            serde_json::to_string(&AppMenuAction::ShowTerminal).unwrap(),
            "\"show-terminal\""
        );
        assert_eq!(
            serde_json::to_string(&AppMenuAction::ShowSftp).unwrap(),
            "\"show-sftp\""
        );
        assert_eq!(
            serde_json::to_string(&AppMenuAction::CheckForUpdates).unwrap(),
            "\"check-for-updates\""
        );
    }
}
