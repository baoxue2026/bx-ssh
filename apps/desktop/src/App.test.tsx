import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import i18n from "./i18n";
import { UiPreferencesProvider } from "./ui/preferences";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage(message: unknown): void }>,
  eventListeners: new Map<
    string,
    Array<(event: { payload: unknown }) => void>
  >(),
  invoke: vi.fn(),
  window: {
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    minimize: vi.fn(() => Promise.resolve()),
    onResized: vi.fn(() => Promise.resolve(vi.fn())),
    toggleMaximize: vi.fn(() => Promise.resolve()),
  },
  terminalReset: vi.fn(),
  terminalWrite: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, listener: (event: { payload: unknown }) => void) => {
      const listeners = mocks.eventListeners.get(event) ?? [];
      listeners.push(listener);
      mocks.eventListeners.set(event, listeners);
      return Promise.resolve(vi.fn());
    },
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mocks.window,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = vi.fn();

    constructor() {
      mocks.channels.push(this);
    }
  },
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("./components/TerminalPane", async () => {
  const React = await import("react");
  return {
    TerminalPane: React.forwardRef(function MockTerminalPane(_, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: vi.fn(),
        reset: mocks.terminalReset,
        viewport: () => ({
          columns: 80,
          rows: 24,
          pixelWidth: 800,
          pixelHeight: 600,
        }),
        write: mocks.terminalWrite,
      }));
      return <div role="application" aria-label="SSH 终端" />;
    }),
  };
});

describe("App", { timeout: 15_000 }, () => {
  beforeEach(async () => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeMode;
    document.documentElement.style.colorScheme = "";
    document.documentElement.lang = "zh-CN";
    await i18n.changeLanguage("zh-CN");
    mocks.channels.length = 0;
    mocks.eventListeners.clear();
    mocks.invoke.mockReset();
    mocks.window.close.mockClear();
    mocks.window.isMaximized.mockClear();
    mocks.window.isMaximized.mockResolvedValue(false);
    mocks.window.minimize.mockClear();
    mocks.window.onResized.mockClear();
    mocks.window.toggleMaximize.mockClear();
    mocks.terminalReset.mockReset();
    mocks.terminalWrite.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      if (command === "list_connections") {
        return Promise.resolve({ groups: [], connections: [] });
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the terminal validation workspace", async () => {
    renderApp();

    expect(
      screen.getByRole("heading", { name: "连接验证" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("application", { name: "SSH 终端" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "应用菜单" })).toBeVisible();
    expect(screen.getByRole("button", { name: "文件" })).toBeVisible();
    expect(screen.getByRole("button", { name: "工作区" })).toBeVisible();
    expect(screen.getByRole("button", { name: "帮助" })).toBeVisible();

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("app_info");
      expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    });
  });

  it("opens the connection editor from the sidebar", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));

    expect(
      await screen.findByRole("dialog", { name: "新建连接" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "基础信息" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows the first-start state separately from an empty connection list", async () => {
    renderApp();

    expect(
      await screen.findByRole("region", { name: "开始使用 BX SSH" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("创建第一个 SSH 连接，连接配置只保存在本机。"),
    ).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: "导入配置" });
    expect(importButton).toBeEnabled();
    expect(screen.getByText("暂无已保存连接")).toBeInTheDocument();

    fireEvent.click(importButton);

    expect(
      await screen.findByRole("dialog", { name: "导入 OpenSSH 配置" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("preview_openssh_config", {
        path: null,
      });
    });
  });

  it("saves a connection without starting a host probe", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve({ groups: [], connections: [] });
      }
      if (command === "save_connection") {
        return Promise.resolve(null);
      }
      return Promise.resolve();
    });
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));
    await fillConnectionEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        "save_connection",
        expect.objectContaining({
          config: expect.objectContaining({
            name: "测试服务器",
            host: "server.example.com",
            username: "root",
          }),
        }),
      );
      expect(
        screen.queryByRole("dialog", { name: "新建连接" }),
      ).not.toBeInTheDocument();
    });
    expect(commandCalls("probe_ssh_host")).toHaveLength(0);
  });

  it("saves before probing when using save and connect", async () => {
    const commandOrder: string[] = [];
    let savedConfig: Record<string, unknown> | undefined;
    mocks.invoke.mockImplementation((command: string, payload?: unknown) => {
      commandOrder.push(command);
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve({ groups: [], connections: [] });
      }
      if (command === "save_connection") {
        savedConfig = (payload as { config: Record<string, unknown> }).config;
        return Promise.resolve(null);
      }
      if (command === "get_connection") {
        return Promise.resolve({
          connection: {
            config: savedConfig,
            isFavorite: false,
            sortOrder: 0,
            lastConnectedAt: null,
            successfulConnectionCount: 0,
            revision: 0,
          },
          settings: {
            layers: { global: null, group: null, connection: null },
            resolved: { connectTimeoutSecs: 10, keepAliveSecs: 30 },
          },
        });
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      return Promise.resolve();
    });
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));
    await fillConnectionEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("probe_ssh_host", {
        request: {
          host: "server.example.com",
          port: 22,
          settings: { connectTimeoutSecs: 10, keepAliveSecs: 30 },
        },
      });
      expect(screen.getByText("信任此主机指纹")).toBeInTheDocument();
    });
    expect(commandOrder.indexOf("save_connection")).toBeLessThan(
      commandOrder.indexOf("probe_ssh_host"),
    );
  });

  it("keeps the editor open and does not probe when saving fails", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve({ groups: [], connections: [] });
      }
      if (command === "save_connection") {
        return Promise.reject({
          code: "database_query_failed",
          message: "Database is read-only",
        });
      }
      return Promise.resolve();
    });
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));
    await fillConnectionEditor();

    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));

    expect(await screen.findByText("保存连接失败")).toBeInTheDocument();
    expect(screen.getByText("Database is read-only")).toBeInTheDocument();
    expect(await editorField("connection-name")).toHaveValue("测试服务器");
    expect(commandCalls("probe_ssh_host")).toHaveLength(0);
  });

  it("copies a saved connection with a new identifier", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(savedConnectionCatalog());
      }
      if (command === "get_connection") {
        return Promise.resolve(savedConnectionDetails());
      }
      if (command === "save_connection") {
        return Promise.resolve(null);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(
      await screen.findByRole("button", { name: "复制 生产服务器" }),
    );
    expect(await editorField("connection-name")).toHaveValue("生产服务器 副本");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(commandCalls("save_connection")).toHaveLength(1),
    );
    const request = commandCalls("save_connection")[0][1] as {
      config: { id: string; name: string };
    };
    expect(request.config.id).not.toBe("connection-production");
    expect(request.config.name).toBe("生产服务器 副本");
  });

  it("requires confirmation before deleting only the local connection", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(savedConnectionCatalog());
      }
      if (command === "delete_connection") {
        return Promise.resolve(true);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(
      await screen.findByRole("button", { name: "删除 生产服务器" }),
    );
    expect(commandCalls("delete_connection")).toHaveLength(0);
    expect(
      screen.getByText(/只移除本机连接配置，不删除或修改远程数据/),
    ).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: /取\s*消/ });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "删除本机配置" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("delete_connection", {
        id: "connection-production",
      });
    });
    expect(commandCalls("close_terminal_session")).toHaveLength(0);
    expect(commandCalls("close_sftp_session")).toHaveLength(0);
  });

  it("organizes connections once by group order with favorites first", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(organizedConnectionCatalog());
      }
      return Promise.resolve();
    });
    renderApp();

    const production = await screen.findByRole("region", {
      name: "生产环境",
    });
    const testing = screen.getByRole("region", { name: "测试环境" });
    const ungrouped = screen.getByRole("region", { name: "未分组" });
    expect(
      production.compareDocumentPosition(testing) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(production).toHaveTextContent("收藏服务器");
    expect(production).toHaveTextContent("普通服务器");
    expect(production.textContent?.indexOf("收藏服务器")).toBeLessThan(
      production.textContent?.indexOf("普通服务器") ?? 0,
    );
    expect(ungrouped).toHaveTextContent("遗失分组服务器");
    expect(screen.getAllByText("遗失分组服务器")).toHaveLength(1);
  });

  it("replaces the connection tree with searchable matched fields", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(organizedConnectionCatalog());
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.change(
      await screen.findByRole("textbox", { name: "搜索已保存连接" }),
      { target: { value: "生产 prod" } },
    );

    expect(screen.getByText("搜索结果")).toBeInTheDocument();
    expect(screen.getByText("2 项")).toBeInTheDocument();
    expect(screen.getByText("普通服务器")).toBeInTheDocument();
    expect(screen.getAllByText(/命中：/)[0]).toHaveTextContent("主机、分组");
    expect(
      screen.queryByRole("region", { name: "生产环境" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索已保存连接" }), {
      target: { value: "does-not-exist" },
    });
    expect(screen.getByText("没有搜索结果")).toBeInTheDocument();
    expect(
      screen.getByText("没有连接匹配“does-not-exist”。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(
      screen.getByRole("region", { name: "生产环境" }),
    ).toBeInTheDocument();
  });

  it("shows the three most recent connections when there is no session", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(recentConnectionCatalog());
      }
      return Promise.resolve();
    });
    renderApp();

    const emptyState = await screen.findByRole("region", {
      name: "当前没有活动会话",
    });
    expect(within(emptyState).getByText("最近连接")).toBeInTheDocument();
    expect(
      within(emptyState).getAllByRole("button", { name: "快速连接" }),
    ).toHaveLength(3);
    expect(emptyState).toHaveTextContent("最近服务器 4");
    expect(emptyState).not.toHaveTextContent("最近服务器 1");
  });

  it("switches between the connection tree and the complete recent view", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(recentConnectionCatalog());
      }
      return Promise.resolve();
    });
    renderApp();

    const switcher = await screen.findByRole("group", {
      name: "连接列表视图",
    });
    fireEvent.click(within(switcher).getByText("最近"));

    const recentRegion = screen.getByRole("region", { name: "最近" });
    expect(recentRegion).toHaveTextContent("最近服务器 4");
    expect(recentRegion).toHaveTextContent("最近服务器 1");
    expect(
      screen.queryByRole("region", { name: "未分组" }),
    ).not.toBeInTheDocument();
  });

  it("shows a dedicated empty state in the recent view", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(savedConnectionCatalog());
      }
      return Promise.resolve();
    });
    renderApp();

    const switcher = await screen.findByRole("group", {
      name: "连接列表视图",
    });
    fireEvent.click(within(switcher).getByText("最近"));

    expect(screen.getByText("暂无最近连接")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示全部连接" }));
    expect(await screen.findByText("生产服务器")).toBeInTheDocument();
  });

  it("opens a saved connection from the tree with Enter", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(savedConnectionCatalog());
      }
      if (command === "get_connection") {
        return Promise.resolve(savedConnectionDetails());
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      return Promise.resolve();
    });
    renderApp();

    await screen.findByText("生产服务器");
    const connection = document.querySelector<HTMLElement>(
      ".connection-catalog-item",
    );
    if (!connection) throw new Error("missing saved connection item");
    fireEvent.keyDown(connection, { key: "Enter" });

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("get_connection", {
        id: "connection-production",
      });
      expect(mocks.invoke).toHaveBeenCalledWith("probe_ssh_host", {
        request: {
          host: "prod.example.com",
          port: 22,
          settings: { connectTimeoutSecs: 15, keepAliveSecs: 45 },
        },
      });
    });
  });

  it("resizes, persists, resets and collapses the connection sidebar", async () => {
    renderApp();

    const workspace = document.querySelector(".workspace");
    const separator = screen.getByRole("separator", {
      name: "调整连接侧栏宽度",
    });
    expect(workspace).toHaveStyle({
      gridTemplateColumns: "240px minmax(0, 1fr)",
    });

    fireEvent.keyDown(separator, { key: "End" });
    expect(workspace).toHaveStyle({
      gridTemplateColumns: "420px minmax(0, 1fr)",
    });
    expect(localStorage.getItem("bx-ssh.sidebar-width")).toBe("420");

    fireEvent.doubleClick(separator);
    expect(workspace).toHaveStyle({
      gridTemplateColumns: "240px minmax(0, 1fr)",
    });

    fireEvent.click(screen.getByRole("button", { name: "折叠连接侧栏" }));
    expect(workspace).toHaveStyle({
      gridTemplateColumns: "32px minmax(0, 1fr)",
    });
    expect(
      screen.queryByRole("separator", { name: "调整连接侧栏宽度" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开连接侧栏" }));
    expect(workspace).toHaveStyle({
      gridTemplateColumns: "240px minmax(0, 1fr)",
    });
  });

  it("quick-connect loads a recent connection and starts the real probe flow", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(recentConnectionCatalog());
      }
      if (command === "get_connection") {
        return Promise.resolve(recentConnectionDetails(4));
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      return Promise.resolve();
    });
    renderApp();

    const recentState = await screen.findByRole("region", {
      name: "当前没有活动会话",
    });
    fireEvent.click(
      within(recentState).getAllByRole("button", { name: "快速连接" })[0],
    );
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("get_connection", {
        id: "connection-recent-4",
      });
      expect(mocks.invoke).toHaveBeenCalledWith("probe_ssh_host", {
        request: {
          host: "recent-4.example.com",
          port: 22,
          settings: { connectTimeoutSecs: 15, keepAliveSecs: 45 },
        },
      });
    });
    expect(screen.getByText("信任此主机指纹")).toBeInTheDocument();
  });

  it("persists favorite and group collapse actions through IPC", async () => {
    let catalog = organizedConnectionCatalog();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(catalog);
      }
      if (command === "set_connection_favorite") {
        catalog = {
          ...catalog,
          connections: catalog.connections.map((item) =>
            item.config.id === "connection-plain"
              ? { ...item, isFavorite: true }
              : item,
          ),
        };
        return Promise.resolve(true);
      }
      if (command === "set_connection_group_collapsed") {
        catalog = {
          ...catalog,
          groups: catalog.groups.map((group) =>
            group.id === "group-production"
              ? { ...group, isCollapsed: true }
              : group,
          ),
        };
        return Promise.resolve(true);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(
      await screen.findByRole("button", { name: "收藏 普通服务器" }),
    );
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("set_connection_favorite", {
        id: "connection-plain",
        isFavorite: true,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "折叠分组 生产环境" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        "set_connection_group_collapsed",
        { id: "group-production", isCollapsed: true },
      );
      expect(screen.queryByText("普通服务器")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "展开分组 生产环境" }),
      ).toBeInTheDocument();
    });
  }, 30_000);

  it("persists connection ordering within its favorite section", async () => {
    const baseCatalog = organizedConnectionCatalog();
    const plainConnection = baseCatalog.connections.find(
      (item) => item.config.id === "connection-plain",
    );
    if (!plainConnection) throw new Error("missing test connection");
    const catalog = {
      ...baseCatalog,
      connections: [
        ...baseCatalog.connections,
        {
          ...plainConnection,
          config: {
            ...plainConnection.config,
            id: "connection-plain-second",
            name: "备用服务器",
          },
          sortOrder: 1,
        },
      ],
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(catalog);
      }
      if (command === "reorder_connections") {
        return Promise.resolve(null);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(
      await screen.findByRole("button", { name: "下移 普通服务器" }),
    );
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("reorder_connections", {
        groupId: "group-production",
        ids: [
          "connection-favorite",
          "connection-plain-second",
          "connection-plain",
        ],
      });
    });
  });

  it("creates a colored connection group and persists group ordering", async () => {
    let catalog = organizedConnectionCatalog();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(catalog);
      }
      if (command === "save_connection_group") {
        return Promise.resolve(null);
      }
      if (command === "reorder_connection_groups") {
        catalog = {
          ...catalog,
          groups: [...catalog.groups].reverse(),
        };
        return Promise.resolve(null);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "新建分组" }));
    const dialog = await screen.findByRole("dialog", { name: "新建连接分组" });
    fireEvent.change(screen.getByLabelText("分组名称"), {
      target: { value: "开发环境" },
    });
    fireEvent.change(screen.getByLabelText("分组颜色值"), {
      target: { value: "#722ED1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*定/ }));

    await waitFor(() => {
      expect(commandCalls("save_connection_group")).toHaveLength(1);
    });
    expect(commandCalls("save_connection_group")[0][1]).toEqual({
      group: expect.objectContaining({
        name: "开发环境",
        color: "#722ED1",
        sortOrder: 2,
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "下移分组 生产环境" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("reorder_connection_groups", {
        ids: ["group-testing", "group-production"],
      });
    });
  });

  it("checks for a signed application update", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "check_for_update") {
        return Promise.resolve({
          currentVersion: "0.1.0",
          version: "0.1.1",
          notes: "Signed prototype update",
          publishedAt: null,
        });
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("发现新版本 v0.1.1")).toBeInTheDocument();
    expect(screen.getByText("Signed prototype update")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("check_for_update");
  });

  it("prevents duplicate update checks while a request is pending", async () => {
    let resolveCheck: ((value: null) => void) | undefined;
    const checkResponse = new Promise<null>((resolve) => {
      resolveCheck = resolve;
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "check_for_update") {
        return checkResponse;
      }
      return Promise.resolve();
    });
    renderApp();

    const checkButton = screen.getByRole("button", { name: "检查更新" });
    act(() => {
      checkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      checkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "check_for_update",
      ),
    ).toHaveLength(1);

    await act(async () => resolveCheck?.(null));
    expect(
      await screen.findByText("当前版本 v0.1.0 已是最新版本。"),
    ).toBeInTheDocument();
  });

  it("controls the native window from the custom title bar", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));

    expect(mocks.window.minimize).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(mocks.window.toggleMaximize).toHaveBeenCalledOnce();
      expect(mocks.window.close).toHaveBeenCalledOnce();
    });
  });

  it("handles visible and native application menu actions", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "check_for_update") {
        return Promise.resolve(null);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    fireEvent.click(
      await screen.findByText("SFTP", {
        selector: ".app-menu-item-label > span",
      }),
    );
    expect(
      screen.getByText("SFTP v3", { selector: ".sidebar-heading span" }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(mocks.eventListeners.get("app-menu-action")).toHaveLength(1),
    );
    const menuListener = mocks.eventListeners.get("app-menu-action")![0];
    act(() => menuListener({ payload: "show-terminal" }));
    expect(
      screen.getByText("SSH / PTY", { selector: ".sidebar-heading span" }),
    ).toBeInTheDocument();

    act(() => menuListener({ payload: "check-for-updates" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("check_for_update");
    });
    expect(
      await screen.findByText("当前版本 v0.1.0 已是最新版本。"),
    ).toBeInTheDocument();
  });

  it("requires an explicit host fingerprint probe", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("probe_ssh_host", {
        request: {
          host: "127.0.0.1",
          port: 22,
          settings: { connectTimeoutSecs: 10, keepAliveSecs: 30 },
        },
      });
      expect(screen.getByText("ssh-ed25519")).toBeInTheDocument();
      expect(screen.getByText("信任此主机指纹")).toBeInTheDocument();
    });
  });

  it("announces connection failures assertively", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "probe_ssh_host") {
        return Promise.reject({
          code: "connection_refused",
          message: "Connection refused",
          stage: "connectingTcp",
        });
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent(
      "目标主机拒绝了 SSH 连接，请检查地址、端口和 SSH 服务状态。",
    );
  });

  it("requires confirmation before exiting with active work", async () => {
    renderApp();

    await waitFor(() =>
      expect(mocks.eventListeners.get("app-exit-requested")).toHaveLength(1),
    );
    const exitListener = mocks.eventListeners.get("app-exit-requested")![0];
    act(() =>
      exitListener({
        payload: { activeSessions: 2, activeTransfers: 1 },
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: "退出 BX SSH？" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (text) =>
          text.startsWith("当前有 2 个活动会话") &&
          text.includes("1 个进行中的文件传输") &&
          text.endsWith("退出将终止传输并断开所有连接。"),
      ),
    ).toBeInTheDocument();

    const cancel = screen.getByRole("button", { name: /取\s*消/ });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "退出 BX SSH？" }),
      ).not.toBeInTheDocument(),
    );

    act(() =>
      exitListener({
        payload: { activeSessions: 1, activeTransfers: 0 },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "退出并断开" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("confirm_app_exit");
    });
  });

  it("acknowledges binary output after xterm processes it", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    let resolveStart: ((value: unknown) => void) | undefined;
    const startResponse = new Promise((resolve) => {
      resolveStart = resolve;
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      if (command === "start_password_shell") {
        return startResponse;
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));
    await screen.findByText("信任此主机指纹");
    fireEvent.click(screen.getByRole("checkbox", { name: "信任此主机指纹" }));
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "bxssh" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => {
      expect(mocks.terminalReset).toHaveBeenCalledOnce();
      expect(mocks.invoke).toHaveBeenCalledWith("set_webview_memory_usage", {
        low: true,
      });
      expect(mocks.invoke).toHaveBeenCalledWith(
        "start_password_shell",
        expect.objectContaining({
          onState: mocks.channels[0],
          onEvent: mocks.channels[1],
          onOutput: mocks.channels[2],
        }),
      );
    });

    const output = Uint8Array.from([0x62, 0x78]).buffer;
    act(() => mocks.channels[2].onmessage(output));
    const processed = mocks.terminalWrite.mock.calls[0][1] as () => void;
    act(processed);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "acknowledge_terminal_output",
      expect.anything(),
    );

    resolveStart?.({
      sessionId: "session-1",
      hostKey: {
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("acknowledge_terminal_output", {
        sessionId: "session-1",
        sequence: 1,
      });
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(mocks.invoke).not.toHaveBeenCalledWith(
        "set_webview_memory_usage",
        { low: false },
      );
    });
  });

  it("shows native SSH stages and cancels an active connection attempt", async () => {
    const pendingStart = new Promise(() => undefined);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      if (command === "start_password_shell") {
        return pendingStart;
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));
    await screen.findByText("信任此主机指纹");
    fireEvent.click(screen.getByRole("checkbox", { name: "信任此主机指纹" }));
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "bxssh" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() =>
      expect(commandCalls("start_password_shell")).toHaveLength(1),
    );
    const startCall = commandCalls("start_password_shell")[0][1] as {
      request: { attemptId: string };
      onState: { onmessage(message: unknown): void };
    };
    act(() =>
      startCall.onState.onmessage({
        attemptId: startCall.request.attemptId,
        stage: "handshaking",
      }),
    );
    expect(await screen.findAllByText("正在进行 SSH 握手")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_ssh_connection", {
        attemptId: startCall.request.attemptId,
      });
      expect(screen.getAllByText("等待连接")).not.toHaveLength(0);
      expect(
        screen.queryByRole("button", { name: "取消连接" }),
      ).not.toBeInTheDocument();
    });
  });

  it("opens an SFTP session and renders the remote directory", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      if (command === "start_password_sftp") {
        return Promise.resolve({
          sessionId: "sftp-1",
          hostKey: {
            algorithm: "ssh-ed25519",
            fingerprintSha256:
              "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
          directory: {
            path: "/home/bxssh",
            entries: [
              {
                name: "logs",
                path: "/home/bxssh/logs",
                kind: "directory",
                size: 4096,
                modifiedAt: 1_700_000_000,
                permissions: 493,
              },
            ],
          },
        });
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByText("SFTP"));
    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));
    await screen.findByText("信任此主机指纹");
    fireEvent.click(screen.getByRole("checkbox", { name: "信任此主机指纹" }));
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "bxssh" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    expect(await screen.findByText("logs")).toBeInTheDocument();
    expect(screen.getByLabelText("远端路径")).toHaveValue("/home/bxssh");
    expect(mocks.invoke).toHaveBeenCalledWith("start_password_sftp", {
      request: expect.objectContaining({
        username: "bxssh",
        password: "secret",
        settings: { connectTimeoutSecs: 10, keepAliveSecs: 30 },
        initialPath: ".",
      }),
      onState: expect.anything(),
    });
  });

  it("confirms the active session and transfer impact before closing SFTP", async () => {
    let resolveUpload: ((value: unknown) => void) | undefined;
    const upload = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      if (command === "start_password_sftp") {
        return Promise.resolve({
          sessionId: "sftp-active",
          hostKey: {
            algorithm: "ssh-ed25519",
            fingerprintSha256:
              "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
          directory: { path: "/home/bxssh", entries: [] },
        });
      }
      if (command === "upload_sftp_file") {
        return upload;
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByText("SFTP"));
    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));
    await screen.findByText("信任此主机指纹");
    fireEvent.click(screen.getByRole("checkbox", { name: "信任此主机指纹" }));
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "bxssh" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await screen.findByText("目录为空");

    fireEvent.change(screen.getByLabelText("上传本地源文件"), {
      target: { value: "D:\\release.zip" },
    });
    fireEvent.change(screen.getByLabelText("上传远端目标"), {
      target: { value: "/home/bxssh/release.zip" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    fireEvent.click(screen.getByRole("button", { name: "断开" }));

    const dialog = await screen.findByRole("dialog", { name: "关闭会话？" });
    expect(within(dialog).getByText(/1 个活动连接/)).toHaveTextContent(
      "1 个进行中的文件传输",
    );
    const cancel = within(dialog).getByRole("button", { name: /取\s*消/ });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(commandCalls("close_sftp_session")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "断开并关闭" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("close_sftp_session", {
        sessionId: "sftp-active",
      });
      expect(
        screen.queryByRole("dialog", { name: "关闭会话？" }),
      ).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveUpload?.({
        bytes: 1024,
        bytesPerSecond: 1024,
        sha256: "a".repeat(64),
      });
    });
    expect(screen.queryByText("1.00 KiB")).not.toBeInTheDocument();
  });

  it("confirms before closing a saved live session", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve(savedConnectionCatalog());
      }
      if (command === "get_connection") {
        return Promise.resolve(savedConnectionDetails());
      }
      if (command === "probe_ssh_host") {
        return Promise.resolve({
          algorithm: "ssh-ed25519",
          fingerprintSha256:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
      if (command === "start_password_shell") {
        return Promise.resolve({
          sessionId: "session-saved",
          hostKey: {
            algorithm: "ssh-ed25519",
            fingerprintSha256:
              "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        });
      }
      if (command === "record_successful_connection") {
        return Promise.reject({
          code: "database_query_failed",
          message: "recent history unavailable",
        });
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.change(
      await screen.findByRole("textbox", { name: "搜索已保存连接" }),
      { target: { value: "生产" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "打开 生产服务器" }),
    );
    const fingerprintDialog = await screen.findByRole("dialog", {
      name: "确认主机身份",
    });
    expect(
      screen.getByRole("tab", { name: /生产服务器.*等待连接/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(
      screen.getByText("SSH / PTY", { selector: ".sidebar-heading span" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(fingerprintDialog).getByRole("button", { name: "信任并继续" }),
    );
    const authenticationDialog = await screen.findByRole("dialog", {
      name: "输入连接密码",
    });
    fireEvent.change(within(authenticationDialog).getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(
      within(authenticationDialog).getByRole("button", { name: /连\s*接/ }),
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        "start_password_shell",
        expect.objectContaining({
          request: expect.objectContaining({
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            password: "secret",
            expectedFingerprint:
              "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            settings: { connectTimeoutSecs: 15, keepAliveSecs: 45 },
          }),
        }),
      );
      expect(mocks.invoke).toHaveBeenCalledWith(
        "record_successful_connection",
        { id: "connection-production" },
      );
      expect(screen.getAllByText("已连接")).not.toHaveLength(0);
    });
    expect(
      screen.queryByText("recent history unavailable"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "输入连接密码" }),
      ).not.toBeInTheDocument(),
    );

    const disconnect = screen.getByRole("button", { name: "断开" });
    fireEvent.click(disconnect);
    expect(commandCalls("close_terminal_session")).toHaveLength(0);
    const closeDialog = (
      await screen.findByText("关闭会话？")
    ).closest<HTMLElement>('[role="dialog"]');
    expect(closeDialog).not.toBeNull();
    if (!closeDialog) throw new Error("close session dialog was not rendered");
    await waitFor(() => expect(closeDialog).toBeVisible());
    expect(within(closeDialog).getByText(/生产服务器/)).toHaveTextContent(
      "1 个活动连接",
    );
    const cancel = within(closeDialog).getByRole("button", {
      name: /取\s*消/,
    });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(cancel);
    await waitFor(() => expect(closeDialog).not.toBeVisible());
    expect(commandCalls("close_terminal_session")).toHaveLength(0);

    fireEvent.click(disconnect);
    await waitFor(() => expect(closeDialog).toBeVisible());
    fireEvent.click(
      within(closeDialog).getByRole("button", {
        name: "断开并关闭",
      }),
    );
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("close_terminal_session", {
        sessionId: "session-saved",
      });
      expect(
        screen.queryByRole("tab", { name: /生产服务器/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("stops unsupported saved authentication before probing the host", async () => {
    const saved = savedConnectionDetails();
    const details = {
      ...saved,
      connection: {
        ...saved.connection,
        config: {
          ...saved.connection.config,
          authMethod: "privateKey" as const,
          keyReferenceId: "key-production",
        },
      },
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "app_info") {
        return Promise.resolve({ name: "BX SSH", version: "0.1.0" });
      }
      if (command === "list_connections") {
        return Promise.resolve({
          groups: [],
          connections: [details.connection],
        });
      }
      if (command === "get_connection") {
        return Promise.resolve(details);
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(
      await screen.findByRole("button", { name: "打开 生产服务器" }),
    );

    expect(await screen.findByText(/对应认证能力尚未接入/)).toBeInTheDocument();
    expect(commandCalls("probe_ssh_host")).toHaveLength(0);
    expect(commandCalls("start_password_shell")).toHaveLength(0);
  });
});

function renderApp() {
  return render(
    <UiPreferencesProvider>
      <App />
    </UiPreferencesProvider>,
  );
}

async function fillConnectionEditor() {
  fireEvent.change(await editorField("connection-name"), {
    target: { value: "测试服务器" },
  });
  fireEvent.change(await editorField("connection-host"), {
    target: { value: "server.example.com" },
  });
  fireEvent.change(await editorField("connection-username"), {
    target: { value: "root" },
  });
}

async function editorField(id: string): Promise<HTMLInputElement> {
  await screen.findByRole("dialog", { name: /连接/ });
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing connection editor field: ${id}`);
  }
  return element;
}

function commandCalls(command: string) {
  return mocks.invoke.mock.calls.filter(([called]) => called === command);
}

function savedConnectionCatalog() {
  return {
    groups: [],
    connections: [savedConnectionDetails().connection],
  };
}

function savedConnectionDetails() {
  return {
    connection: {
      config: {
        id: "connection-production",
        groupId: null,
        name: "生产服务器",
        host: "prod.example.com",
        port: 22,
        username: "deploy",
        notes: null,
        color: "#1677ff",
        authMethod: "password",
        credentialRef: null,
        keyReferenceId: null,
      },
      isFavorite: false,
      sortOrder: 0,
      lastConnectedAt: null,
      successfulConnectionCount: 0,
      revision: 0,
    },
    settings: {
      layers: {
        global: null,
        group: null,
        connection: {
          connectTimeoutSecs: 15,
          keepAliveSecs: 45,
        },
      },
      resolved: {
        connectTimeoutSecs: 15,
        keepAliveSecs: 45,
      },
    },
  };
}

function organizedConnectionCatalog() {
  const connection = (
    id: string,
    name: string,
    groupId: string | null,
    isFavorite: boolean,
    sortOrder: number,
  ) => ({
    ...savedConnectionDetails().connection,
    config: {
      ...savedConnectionDetails().connection.config,
      id,
      name,
      groupId,
    },
    isFavorite,
    sortOrder,
  });
  return {
    groups: [
      {
        id: "group-testing",
        name: "测试环境",
        color: "#52C41A",
        sortOrder: 1,
        isCollapsed: false,
        revision: 1,
      },
      {
        id: "group-production",
        name: "生产环境",
        color: "#1677FF",
        sortOrder: 0,
        isCollapsed: false,
        revision: 1,
      },
    ],
    connections: [
      connection(
        "connection-plain",
        "普通服务器",
        "group-production",
        false,
        0,
      ),
      connection(
        "connection-favorite",
        "收藏服务器",
        "group-production",
        true,
        8,
      ),
      connection("connection-testing", "测试服务器", "group-testing", false, 0),
      connection(
        "connection-orphan",
        "遗失分组服务器",
        "missing-group",
        false,
        0,
      ),
    ],
  };
}

function recentConnectionCatalog() {
  return {
    groups: [],
    connections: [1, 2, 3, 4].map(
      (index) => recentConnectionDetails(index).connection,
    ),
  };
}

function recentConnectionDetails(index: number) {
  const details = savedConnectionDetails();
  return {
    ...details,
    connection: {
      ...details.connection,
      config: {
        ...details.connection.config,
        id: `connection-recent-${index}`,
        name: `最近服务器 ${index}`,
        host: `recent-${index}.example.com`,
      },
      lastConnectedAt: 1_700_000_000_000 + index * 1_000,
      successfulConnectionCount: index,
    },
  };
}
