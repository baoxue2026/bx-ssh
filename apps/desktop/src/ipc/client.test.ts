import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError, ipc } from "./client";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage(message: unknown): void }>,
  invoke: vi.fn(),
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

describe("IPC client", () => {
  beforeEach(() => {
    mocks.channels.length = 0;
    mocks.invoke.mockReset();
  });

  it("unwraps generated command errors into stable IpcError values", async () => {
    mocks.invoke.mockRejectedValue({
      code: "host_key_mismatch",
      message: "The host key changed",
    });

    const error = await ipc
      .probeSshHost({ host: "example.com", port: 22 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({
      code: "host_key_mismatch",
      message: "The host key changed",
    });
  });

  it("classifies unexpected invocation failures as IPC transport errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("WebView IPC unavailable"));

    const error = await ipc.appInfo().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({
      code: "ipc_transport_error",
      message: "WebView IPC unavailable",
    });
  });

  it("uses generated connection query commands", async () => {
    mocks.invoke.mockResolvedValue({ groups: [], connections: [] });

    await expect(ipc.listConnections()).resolves.toEqual({
      groups: [],
      connections: [],
    });
    expect(mocks.invoke).toHaveBeenCalledWith("list_connections");

    mocks.invoke.mockResolvedValue(null);
    await expect(ipc.getConnection("connection-1")).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("get_connection", {
      id: "connection-1",
    });
  });

  it("creates typed channels for the raw terminal command", async () => {
    const onEvent = vi.fn();
    const onOutput = vi.fn();
    mocks.invoke.mockResolvedValue({
      sessionId: "terminal-1",
      hostKey: {
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });

    await ipc.startPasswordShell(
      {
        host: "example.com",
        port: 22,
        username: "bxssh",
        password: "secret",
        expectedFingerprint:
          "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        columns: 80,
        rows: 24,
        pixelWidth: 800,
        pixelHeight: 600,
      },
      { onEvent, onOutput },
    );

    expect(mocks.invoke).toHaveBeenCalledWith("start_password_shell", {
      request: expect.objectContaining({ username: "bxssh", columns: 80 }),
      onEvent: mocks.channels[0],
      onOutput: mocks.channels[1],
    });

    const output = Uint8Array.from([0x62, 0x78]).buffer;
    mocks.channels[0].onmessage({ type: "exited", code: 0, signal: null });
    mocks.channels[1].onmessage(output);

    expect(onEvent).toHaveBeenCalledWith({
      type: "exited",
      code: 0,
      signal: null,
    });
    expect(onOutput).toHaveBeenCalledWith(output);
  });

  it("normalizes errors from the native update channel command", async () => {
    mocks.invoke.mockRejectedValue({
      code: "update_signature_invalid",
      message: "Update signature verification failed",
    });

    await expect(ipc.installUpdate("0.2.0", vi.fn())).rejects.toMatchObject({
      name: "IpcError",
      code: "update_signature_invalid",
      message: "Update signature verification failed",
    });
  });
});
