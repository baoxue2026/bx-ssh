import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { OpenSshImportPreview } from "../ipc/bindings";
import { OpenSshImportDialog } from "./OpenSshImportDialog";

const preview: OpenSshImportPreview = {
  sourcePath: "C:\\Users\\bx\\.ssh\\config",
  sourceFingerprint: "SHA256:preview",
  ignoredHostPatterns: 1,
  items: [
    {
      sourceId: "host-prod",
      alias: "生产服务器",
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      identityFile: "C:\\Users\\bx\\.ssh\\id_ed25519",
      duplicateConnectionId: "connection-prod",
      duplicateConnectionName: "生产服务器",
      errors: [],
      warnings: ["duplicate", "identityFileRequiresKeySetup"],
    },
    {
      sourceId: "host-invalid",
      alias: "缺少主机",
      host: "",
      port: 22,
      username: "root",
      identityFile: null,
      duplicateConnectionId: null,
      duplicateConnectionName: null,
      errors: ["missingHost"],
      warnings: [],
    },
    {
      sourceId: "host-stage",
      alias: "测试服务器",
      host: "stage.example.com",
      port: 2200,
      username: "tester",
      identityFile: null,
      duplicateConnectionId: null,
      duplicateConnectionName: null,
      errors: [],
      warnings: [],
    },
  ],
};

describe("OpenSshImportDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("selects only importable entries and disables invalid entries", () => {
    renderDialog();

    expect(
      screen.getByRole("checkbox", { name: "选择全部可导入项（2）" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /选择\s+生产服务器/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /选择\s+测试服务器/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /选择\s+缺少主机/ }),
    ).toBeDisabled();
    expect(screen.queryByText("端口无效")).not.toBeInTheDocument();
    expect(screen.getByText("缺少主机地址")).toBeInTheDocument();
    expect(screen.getByText("检测到 IdentityFile")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "选择全部可导入项（2）" }),
    );

    expect(
      screen.getByRole("checkbox", { name: /选择\s+生产服务器/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /选择\s+测试服务器/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "导入选中项（0）" }),
    ).toBeDisabled();
  });

  it("submits selected entries with the chosen duplicate strategy", () => {
    const onSubmit = vi.fn();
    renderDialog({ onSubmit });
    const dialog = screen.getByRole("dialog", { name: "导入 OpenSSH 配置" });

    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: "覆盖现有连接的主机、端口和用户名",
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "导入选中项（2）" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({
      sourcePath: preview.sourcePath,
      sourceFingerprint: preview.sourceFingerprint,
      selectedSourceIds: ["host-prod", "host-stage"],
      duplicateStrategy: "overwrite",
    });
  });

  it("keeps import actions unavailable while loading", () => {
    const onBrowse = vi.fn();
    const onLoadDefault = vi.fn();
    renderDialog({ loading: true, onBrowse, onLoadDefault });

    expect(screen.getByText("正在解析 OpenSSH 配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择文件" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "导入选中项（2）" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /默认配置/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /默认配置/ }));
    expect(onLoadDefault).not.toHaveBeenCalled();
    expect(onBrowse).not.toHaveBeenCalled();
  });
});

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof OpenSshImportDialog>> = {},
) {
  return render(
    <OpenSshImportDialog
      loading={false}
      open
      pending={false}
      preview={preview}
      onBrowse={vi.fn()}
      onClose={vi.fn()}
      onLoadDefault={vi.fn()}
      onSubmit={vi.fn()}
      {...overrides}
    />,
  );
}
