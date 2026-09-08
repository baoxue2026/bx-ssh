import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { ConnectionListItem } from "../ipc/bindings";
import { ConnectionWorkspaceEmptyState } from "./ConnectionWorkspaceEmptyState";

const recentConnection: ConnectionListItem = {
  config: {
    id: "connection-production",
    groupId: null,
    name: "生产服务器",
    host: "server.example.com",
    port: 22,
    username: "deploy",
    notes: null,
    color: "#1677ff",
    authMethod: "password",
    credentialRef: null,
    keyReferenceId: null,
  },
  isFavorite: true,
  sortOrder: 0,
  lastConnectedAt: 1_700_000_000_000,
  successfulConnectionCount: 3,
  revision: 1,
};

describe("ConnectionWorkspaceEmptyState", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("offers new connection and config import actions on first start", () => {
    const onImportConfig = vi.fn();
    const onNewConnection = vi.fn();
    render(
      <ConnectionWorkspaceEmptyState
        language="zh-CN"
        recentConnections={[]}
        totalConnections={0}
        onImportConfig={onImportConfig}
        onNewConnection={onNewConnection}
        onQuickConnect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "开始使用 BX SSH" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "新建第一个连接" }));
    fireEvent.click(screen.getByRole("button", { name: "导入配置" }));

    expect(onNewConnection).toHaveBeenCalledOnce();
    expect(onImportConfig).toHaveBeenCalledOnce();
    expect(
      screen.getByText("支持从 OpenSSH config 预览并选择连接导入。"),
    ).toBeVisible();
  });

  it("shows recent connections and invokes quick connect without a session", () => {
    const onQuickConnect = vi.fn();
    const onNewConnection = vi.fn();
    render(
      <ConnectionWorkspaceEmptyState
        language="zh-CN"
        recentConnections={[recentConnection]}
        totalConnections={1}
        onImportConfig={vi.fn()}
        onNewConnection={onNewConnection}
        onQuickConnect={onQuickConnect}
      />,
    );

    expect(
      screen.getByRole("region", { name: "当前没有活动会话" }),
    ).toBeVisible();
    expect(screen.getByText("生产服务器")).toBeVisible();
    expect(screen.getByText(/成功 3 次/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "快速连接" }));
    fireEvent.click(screen.getByRole("button", { name: "从空状态新建连接" }));

    expect(onQuickConnect).toHaveBeenCalledWith(recentConnection);
    expect(onNewConnection).toHaveBeenCalledOnce();
  });

  it("disables the quick-connect action while its connection is loading", () => {
    render(
      <ConnectionWorkspaceEmptyState
        language="zh-CN"
        loadingConnectionId={recentConnection.config.id}
        recentConnections={[recentConnection]}
        totalConnections={1}
        onImportConfig={vi.fn()}
        onNewConnection={vi.fn()}
        onQuickConnect={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /快速连接/ })).toBeDisabled();
  });
});
