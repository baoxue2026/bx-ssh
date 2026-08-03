import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import "./styles.css";
import { App } from "./App";

async function start() {
  if (import.meta.env.VITE_E2E === "true") {
    await import("@wdio/tauri-plugin");
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: "#2563eb",
            borderRadius: 6,
            fontFamily:
              'Inter, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
          },
        }}
      >
        <App />
      </ConfigProvider>
    </React.StrictMode>,
  );
}

void start();
