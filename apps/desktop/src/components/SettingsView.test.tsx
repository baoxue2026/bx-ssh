import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import {
  DEFAULT_APPLICATION_SETTINGS,
  DEFAULT_GLOBAL_CONNECTION_SETTINGS,
} from "../ui/applicationSettings";
import type { ApplicationSettings, ConnectionSettings } from "../ipc/bindings";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));

describe("SettingsView", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("renders all phase-one categories and keeps shortcuts read-only", () => {
    renderSettings();
    const settings = screen.getByRole("region", { name: "设置" });
    const navigation = within(settings).getByRole("navigation", {
      name: "设置分类",
    });

    for (const category of [
      "常规",
      "终端",
      "外观",
      "连接",
      "SFTP",
      "安全",
      "快捷键",
      "更新",
      "日志与诊断",
    ]) {
      expect(
        within(navigation).getByRole("button", { name: category }),
      ).toBeVisible();
    }

    fireEvent.click(within(navigation).getByRole("button", { name: "快捷键" }));
    expect(within(settings).getByText("Ctrl+Shift+F")).toBeVisible();
    expect(
      within(settings).getByRole("button", { name: "恢复本类默认值" }),
    ).toBeDisabled();
  });

  it("restores category defaults and saves one atomic snapshot", () => {
    const onSave = vi.fn();
    renderSettings({
      onSave,
      terminalFontSize: 18,
      connectTimeoutSecs: 25,
    });
    const settings = screen.getByRole("region", { name: "设置" });

    fireEvent.click(within(settings).getByRole("button", { name: "终端" }));
    expect(
      within(settings).getByRole("spinbutton", { name: "字号" }),
    ).toHaveValue("18");
    fireEvent.click(
      within(settings).getByRole("button", { name: "恢复本类默认值" }),
    );
    fireEvent.click(within(settings).getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ terminalFontSize: 13 }),
      expect.objectContaining({ connectTimeoutSecs: 25 }),
    );
  });

  it("opens logs and exports diagnostics from the diagnostics category", () => {
    const onOpenLogDirectory = vi.fn();
    const onExportDiagnostics = vi.fn();
    renderSettings({ onExportDiagnostics, onOpenLogDirectory });
    const settings = screen.getByRole("region", { name: "设置" });

    fireEvent.click(
      within(settings).getByRole("button", { name: "日志与诊断" }),
    );
    fireEvent.click(
      within(settings).getByRole("button", { name: "打开日志目录" }),
    );
    fireEvent.click(
      within(settings).getByRole("button", { name: "导出脱敏诊断包" }),
    );

    expect(onOpenLogDirectory).toHaveBeenCalledOnce();
    expect(onExportDiagnostics).toHaveBeenCalledOnce();
  });

  it("uses an operation-level title for loading and action errors", () => {
    renderSettings({ errorMessage: "Command rejected" });
    const settings = screen.getByRole("region", { name: "设置" });

    expect(within(settings).getByText("设置操作失败")).toBeVisible();
    expect(within(settings).getByText("Command rejected")).toBeVisible();
  });
});

function renderSettings({
  connectTimeoutSecs = DEFAULT_GLOBAL_CONNECTION_SETTINGS.connectTimeoutSecs,
  errorMessage,
  onExportDiagnostics = vi.fn(),
  onOpenLogDirectory = vi.fn(),
  onSave = vi.fn() as (
    application: ApplicationSettings,
    connection: ConnectionSettings,
  ) => void,
  terminalFontSize = DEFAULT_APPLICATION_SETTINGS.terminalFontSize,
}: {
  connectTimeoutSecs?: number;
  errorMessage?: string;
  onExportDiagnostics?: () => void;
  onOpenLogDirectory?: () => void;
  onSave?: (
    application: ApplicationSettings,
    connection: ConnectionSettings,
  ) => void;
  terminalFontSize?: number;
} = {}) {
  return render(
    <SettingsView
      appName="BX SSH"
      errorMessage={errorMessage}
      groups={[]}
      left={228}
      settings={{
        application: {
          ...DEFAULT_APPLICATION_SETTINGS,
          terminalFontSize,
        },
        applicationInitialized: true,
        connection: {
          ...DEFAULT_GLOBAL_CONNECTION_SETTINGS,
          connectTimeoutSecs,
        },
      }}
      version="0.1.0"
      onCheckForUpdates={vi.fn()}
      onExportDiagnostics={onExportDiagnostics}
      onOpenLogDirectory={onOpenLogDirectory}
      onClose={vi.fn()}
      onSave={onSave}
    />,
  );
}
