import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import "./i18n";
import { ThemedApplication } from "./ThemedApplication";
import { UiPreferencesProvider } from "./ui/preferences";

async function start() {
  if (import.meta.env.VITE_E2E === "true") {
    await import("@wdio/tauri-plugin");
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <UiPreferencesProvider>
        <ThemedApplication />
      </UiPreferencesProvider>
    </React.StrictMode>,
  );
}

void start();
