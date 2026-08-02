import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Circle, SquareTerminal } from "lucide-react";

interface AppInfo {
  name: string;
  version: string;
}

const fallbackInfo: AppInfo = {
  name: "BX SSH",
  version: "0.1.0",
};

export function App() {
  const [appInfo, setAppInfo] = useState(fallbackInfo);

  useEffect(() => {
    let active = true;

    void invoke<AppInfo>("app_info")
      .then((info) => {
        if (active) {
          setAppInfo(info);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <SquareTerminal size={17} strokeWidth={2.1} />
          </span>
          <span>{appInfo.name}</span>
        </div>
        <span className="version">v{appInfo.version}</span>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <h2>连接</h2>
          <div className="sidebar-empty">暂无连接</div>
        </aside>

        <main className="session" aria-labelledby="empty-session-title">
          <SquareTerminal
            className="session-icon"
            size={40}
            strokeWidth={1.4}
          />
          <h1 id="empty-session-title">当前没有会话</h1>
        </main>
      </div>

      <footer className="statusbar">
        <span className="status-item">
          <Circle className="status-dot" size={7} fill="currentColor" />
          就绪
        </span>
      </footer>
    </div>
  );
}
