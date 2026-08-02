import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = vi.fn();
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
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
        write: vi.fn(),
      }));
      return <div role="application" aria-label="SSH 终端" />;
    }),
  };
});

describe("App", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
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
      expect(invokeMock).toHaveBeenCalledWith("app_info");
      expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    });
  });

  it("requires an explicit host fingerprint probe", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "检测主机指纹" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("probe_ssh_host", {
        request: { host: "127.0.0.1", port: 22 },
      });
      expect(screen.getByText("ssh-ed25519")).toBeInTheDocument();
      expect(screen.getByText("信任此主机指纹")).toBeInTheDocument();
    });
  });
});
