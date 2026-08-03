import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dropdown, Tooltip, type MenuProps } from "antd";
import { Check, Copy, Minus, Square, SquareTerminal, X } from "lucide-react";
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
        label: menuLabel("退出", "Ctrl+Shift+Q"),
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
        label: menuLabel("终端", "Ctrl+1"),
        onClick: () => onWorkspaceModeChange("terminal"),
      },
      {
        key: "sftp",
        disabled: workspaceModeLocked,
        icon: workspaceMode === "sftp" ? <Check size={13} /> : null,
        label: menuLabel("SFTP", "Ctrl+2"),
        onClick: () => onWorkspaceModeChange("sftp"),
      },
    ],
  };
  const helpMenu: MenuProps = {
    items: [
      {
        key: "check-updates",
        label: menuLabel("检查更新", "Ctrl+Shift+U"),
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
      <nav className="app-menu-bar" aria-label="应用菜单">
        <AppMenu label="文件" menu={fileMenu} />
        <AppMenu label="工作区" menu={workspaceMenu} />
        <AppMenu label="帮助" menu={helpMenu} />
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
        <div className="window-controls" aria-label="窗口控制">
          <Tooltip title="最小化" mouseEnterDelay={0.5}>
            <button
              className="window-control"
              type="button"
              aria-label="最小化窗口"
              onClick={minimize}
            >
              <Minus size={14} />
            </button>
          </Tooltip>
          <Tooltip title={maximized ? "还原" : "最大化"} mouseEnterDelay={0.5}>
            <button
              className="window-control"
              type="button"
              aria-label={maximized ? "还原窗口" : "最大化窗口"}
              onClick={toggleMaximize}
            >
              {maximized ? <Copy size={12} /> : <Square size={12} />}
            </button>
          </Tooltip>
          <Tooltip title="关闭" mouseEnterDelay={0.5}>
            <button
              className="window-control window-control-close"
              type="button"
              aria-label="关闭窗口"
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

function menuLabel(label: string, shortcut: string) {
  return (
    <span className="app-menu-item-label">
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </span>
  );
}
