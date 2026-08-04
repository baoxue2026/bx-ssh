import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

describe("App", () => {
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
        request: { host: "127.0.0.1", port: 22 },
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
        return Promise.reject(new Error("Network unavailable"));
      }
      return Promise.resolve();
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("Network unavailable");
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
          onEvent: mocks.channels[0],
          onOutput: mocks.channels[1],
        }),
      );
    });

    const output = Uint8Array.from([0x62, 0x78]).buffer;
    act(() => mocks.channels[1].onmessage(output));
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
        initialPath: ".",
      }),
    });
  });
});

function renderApp() {
  return render(
    <UiPreferencesProvider>
      <App />
    </UiPreferencesProvider>,
  );
}
