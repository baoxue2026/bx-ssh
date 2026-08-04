import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dropdown, Tooltip, type MenuProps } from "antd";
import { Check, Copy, Minus, Square, SquareTerminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiPreferences } from "../ui/preferenceContext";
import { UpdateControl } from "./UpdateControl";

type WorkspaceMode = "terminal" | "sftp";

interface WindowTitleBarProps {
  appName: string;
  connectionLabel: string;
  connectionState: string;
  onCheckForUpdates(): void;
  onWorkspaceModeChange(mode: WorkspaceMode): void;
  updateRequestId: number;
  version: string;
  workspaceMode: WorkspaceMode;
  workspaceModeLocked: boolean;
}

export function WindowTitleBar({
  appName,
  connectionLabel,
  connectionState,
  onCheckForUpdates,
  onWorkspaceModeChange,
  updateRequestId,
  version,
  workspaceMode,
  workspaceModeLocked,
}: WindowTitleBarProps) {
  const { t } = useTranslation();
  const { language, setLanguage, setThemeMode, themeMode } = useUiPreferences();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let removeResizeListener: (() => void) | undefined;

    const refreshMaximized = () => {
      void appWindow
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => undefined);
    };

    refreshMaximized();
    void appWindow
      .onResized(refreshMaximized)
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          removeResizeListener = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      removeResizeListener?.();
    };
  }, []);

  const minimize = () => {
    void getCurrentWindow()
      .minimize()
      .catch(() => undefined);
  };

  const toggleMaximize = () => {
    const appWindow = getCurrentWindow();
    void appWindow
      .toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setMaximized)
      .catch(() => undefined);
  };

  const close = () => {
    void getCurrentWindow()
      .close()
      .catch(() => undefined);
  };

  const fileMenu: MenuProps = {
    items: [
      {
        key: "exit",
        label: menuLabel(t("menu.exit"), "Ctrl+Shift+Q"),
        onClick: close,
      },
    ],
  };
  const workspaceMenu: MenuProps = {
    items: [
      {
        key: "terminal",
        disabled: workspaceModeLocked,
        icon: workspaceMode === "terminal" ? <Check size={13} /> : null,
        label: menuLabel(t("common.terminal"), "Ctrl+1"),
        onClick: () => onWorkspaceModeChange("terminal"),
      },
      {
        key: "sftp",
        disabled: workspaceModeLocked,
        icon: workspaceMode === "sftp" ? <Check size={13} /> : null,
        label: menuLabel(t("common.sftp"), "Ctrl+2"),
        onClick: () => onWorkspaceModeChange("sftp"),
      },
    ],
  };
  const appearanceMenu: MenuProps = {
    items: [
      {
        type: "group",
        label: t("appearance.theme"),
        children: [
          {
            key: "theme-system",
            icon: themeMode === "system" ? <Check size={13} /> : null,
            label: t("appearance.themeSystem"),
            onClick: () => setThemeMode("system"),
          },
          {
            key: "theme-light",
            icon: themeMode === "light" ? <Check size={13} /> : null,
            label: t("appearance.themeLight"),
            onClick: () => setThemeMode("light"),
          },
          {
            key: "theme-dark",
            icon: themeMode === "dark" ? <Check size={13} /> : null,
            label: t("appearance.themeDark"),
            onClick: () => setThemeMode("dark"),
          },
        ],
      },
      { type: "divider" },
      {
        type: "group",
        label: t("appearance.language"),
        children: [
          {
            key: "language-zh-CN",
            icon: language === "zh-CN" ? <Check size={13} /> : null,
            label: t("appearance.languageChinese"),
            onClick: () => setLanguage("zh-CN"),
          },
          {
            key: "language-en-US",
            icon: language === "en-US" ? <Check size={13} /> : null,
            label: t("appearance.languageEnglish"),
            onClick: () => setLanguage("en-US"),
          },
        ],
      },
    ],
  };
  const helpMenu: MenuProps = {
    items: [
      {
        key: "check-updates",
        label: menuLabel(t("menu.checkUpdates"), "Ctrl+Shift+U"),
        onClick: onCheckForUpdates,
      },
    ],
  };

  return (
    <header className="topbar">
      <div className="titlebar-identity" data-tauri-drag-region>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <SquareTerminal size={17} strokeWidth={2.1} />
          </span>
          <span>{appName}</span>
        </div>
      </div>
      <nav className="app-menu-bar" aria-label={t("menu.application")}>
        <AppMenu label={t("menu.file")} menu={fileMenu} />
        <AppMenu label={t("menu.workspace")} menu={workspaceMenu} />
        <AppMenu label={t("menu.appearance")} menu={appearanceMenu} />
        <AppMenu label={t("menu.help")} menu={helpMenu} />
      </nav>
      <div className="titlebar-drag-region" data-tauri-drag-region>
        <div className="topbar-session">
          <span className={`connection-dot state-${connectionState}`} />
          <span>{connectionLabel}</span>
          <span className="version">v{version}</span>
        </div>
      </div>

      <div className="titlebar-actions">
        <UpdateControl currentVersion={version} requestId={updateRequestId} />
        <div className="window-controls" aria-label={t("window.controls")}>
          <Tooltip title={t("window.minimize")} mouseEnterDelay={0.5}>
            <button
              className="window-control"
              type="button"
              aria-label={t("window.minimizeWindow")}
              onClick={minimize}
            >
              <Minus size={14} />
            </button>
          </Tooltip>
          <Tooltip
            title={maximized ? t("window.restore") : t("window.maximize")}
            mouseEnterDelay={0.5}
          >
            <button
              className="window-control"
              type="button"
              aria-label={
                maximized
                  ? t("window.restoreWindow")
                  : t("window.maximizeWindow")
              }
              onClick={toggleMaximize}
            >
              {maximized ? <Copy size={12} /> : <Square size={12} />}
            </button>
          </Tooltip>
          <Tooltip title={t("window.close")} mouseEnterDelay={0.5}>
            <button
              className="window-control window-control-close"
              type="button"
              aria-label={t("window.closeWindow")}
              onClick={close}
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

function AppMenu({ label, menu }: { label: string; menu: MenuProps }) {
  return (
    <Dropdown menu={menu} trigger={["click"]} placement="bottomLeft">
      <button className="app-menu-trigger" type="button">
        {label}
      </button>
    </Dropdown>
  );
}

function menuLabel(label: string, shortcut?: string) {
  return (
    <span className="app-menu-item-label">
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </span>
  );
}
