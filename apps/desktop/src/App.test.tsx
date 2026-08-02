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

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage(message: unknown): void }>,
  invoke: vi.fn(),
  terminalWrite: vi.fn(),
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
        clear: vi.fn(),
        focus: vi.fn(),
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
  beforeEach(() => {
    mocks.channels.length = 0;
    mocks.invoke.mockReset();
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
  });

  it("renders the terminal validation workspace", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "连接验证" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("application", { name: "SSH 终端" }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("app_info");
      expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    });
  });

  it("requires an explicit host fingerprint probe", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("probe_ssh_host", {
        request: { host: "127.0.0.1", port: 22 },
      });
      expect(screen.getByText("ssh-ed25519")).toBeInTheDocument();
      expect(screen.getByText("信任此主机指纹")).toBeInTheDocument();
    });
  });

  it("acknowledges binary output after xterm processes it", async () => {
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
    render(<App />);

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
    });
  });
});
