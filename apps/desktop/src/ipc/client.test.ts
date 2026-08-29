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
      stage: "handshaking",
    });

    const error = await ipc
      .probeSshHost({
        host: "example.com",
        port: 22,
        settings: { connectTimeoutSecs: 10, keepAliveSecs: 30 },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({
      code: "host_key_mismatch",
      message: "The host key changed",
      stage: "handshaking",
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

    const hostKey = {
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    mocks.invoke.mockResolvedValue(hostKey);
    await expect(ipc.getKnownHost("example.com", 2222)).resolves.toEqual(
      hostKey,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("get_known_host", {
      host: "example.com",
      port: 2222,
    });

    mocks.invoke.mockResolvedValue(null);
    await expect(
      ipc.trustHostFingerprint({ host: "example.com", port: 2222, hostKey }),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("trust_host_fingerprint", {
      request: { host: "example.com", port: 2222, hostKey },
    });

    mocks.invoke.mockResolvedValue("secret");
    await expect(ipc.getPasswordCredential("credential-root")).resolves.toBe(
      "secret",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("get_password_credential", {
      credentialRef: "credential-root",
    });

    mocks.invoke.mockResolvedValue(null);
    await expect(
      ipc.savePasswordCredential("credential-root", "secret"),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("save_password_credential", {
      credentialRef: "credential-root",
      password: "secret",
    });
    await expect(ipc.deletePasswordCredential("credential-root")).resolves.toBe(
      undefined,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("delete_password_credential", {
      credentialRef: "credential-root",
    });
  });

  it("uses the controlled local file service commands", async () => {
    const listing = {
      path: "C:\\Users\\bxssh",
      parentPath: "C:\\Users",
      entries: [],
    };
    mocks.invoke.mockResolvedValue(listing);

    await expect(ipc.listLocalDirectory("C:\\Users\\bxssh")).resolves.toEqual(
      listing,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("list_local_directory", {
      request: { path: "C:\\Users\\bxssh" },
    });

    const entry = {
      name: "notes.txt",
      path: "C:\\Users\\bxssh\\notes.txt",
      kind: "file",
      size: 10,
      modifiedAt: 1_700_000_000,
      readonly: false,
      hidden: false,
    };
    mocks.invoke.mockResolvedValue(entry);
    await expect(ipc.statLocalPath(entry.path)).resolves.toEqual(entry);
    expect(mocks.invoke).toHaveBeenCalledWith("stat_local_path", {
      request: { path: entry.path },
    });
  });

  it("uses the remote SFTP stat command", async () => {
    const entry = {
      name: "notes.txt",
      path: "/tmp/notes.txt",
      kind: "file",
      size: 10,
      modifiedAt: 1_700_000_000,
      permissions: 0o640,
    };
    mocks.invoke.mockResolvedValue(entry);

    await expect(
      ipc.statSftpPath("sftp-session-1", "/tmp/notes.txt"),
    ).resolves.toEqual(entry);
    expect(mocks.invoke).toHaveBeenCalledWith("stat_sftp_path", {
      sessionId: "sftp-session-1",
      path: "/tmp/notes.txt",
    });
  });

  it("uses recursive SFTP transfer commands and cancellation", async () => {
    const summary = {
      files: 2,
      directories: 3,
      bytes: 2048,
      elapsedMs: 10,
      bytesPerSecond: 204_800,
    };
    mocks.invoke.mockResolvedValue(summary);

    await expect(
      ipc.uploadSftpDirectory(
        "sftp-session-1",
        "transfer-1",
        "C:\\source",
        "/tmp/source",
        "zh-CN",
      ),
    ).resolves.toEqual(summary);
    expect(mocks.invoke).toHaveBeenCalledWith("upload_sftp_directory", {
      sessionId: "sftp-session-1",
      transferId: "transfer-1",
      localPath: "C:\\source",
      remotePath: "/tmp/source",
      language: "zh-CN",
    });

    await expect(
      ipc.downloadSftpDirectory(
        "sftp-session-1",
        "transfer-1",
        "/tmp/source",
        "C:\\download",
        "zh-CN",
      ),
    ).resolves.toEqual(summary);
    expect(mocks.invoke).toHaveBeenCalledWith("download_sftp_directory", {
      sessionId: "sftp-session-1",
      transferId: "transfer-1",
      remotePath: "/tmp/source",
      localPath: "C:\\download",
      language: "zh-CN",
    });

    mocks.invoke.mockResolvedValue(true);
    await expect(ipc.cancelSftpTransfer("transfer-1")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_sftp_transfer", {
      transferId: "transfer-1",
    });
  });

  it("passes conflict actions to SFTP transfer commands", async () => {
    const summary = {
      bytes: 10,
      elapsedMs: 1,
      bytesPerSecond: 10_000,
      sha256: "a".repeat(64),
    };
    mocks.invoke.mockResolvedValue(summary);

    await expect(
      ipc.uploadSftpFileWithConflict(
        "sftp-session-1",
        "C:\\work\\notes.txt",
        "/tmp/notes.txt",
        "zh-CN",
        "overwrite",
      ),
    ).resolves.toEqual(summary);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "upload_sftp_file_with_conflict",
      {
        sessionId: "sftp-session-1",
        localPath: "C:\\work\\notes.txt",
        remotePath: "/tmp/notes.txt",
        language: "zh-CN",
        conflictAction: "overwrite",
      },
    );

    await expect(
      ipc.downloadSftpDirectoryWithConflict(
        "sftp-session-1",
        "transfer-2",
        "/tmp/release",
        "C:\\work\\release",
        "zh-CN",
        "rename",
      ),
    ).resolves.toEqual(summary);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "download_sftp_directory_with_conflict",
      {
        sessionId: "sftp-session-1",
        transferId: "transfer-2",
        remotePath: "/tmp/release",
        localPath: "C:\\work\\release",
        language: "zh-CN",
        conflictAction: "rename",
      },
    );
  });

  it("uses remote SFTP file operation commands", async () => {
    mocks.invoke.mockResolvedValue(null);

    await expect(
      ipc.createSftpDirectory("sftp-session-1", "/tmp/new"),
    ).resolves.toBeUndefined();
    await expect(
      ipc.deleteSftpEntry("sftp-session-1", "/tmp/old", true),
    ).resolves.toBeUndefined();
    await expect(
      ipc.moveSftpEntry("sftp-session-1", "/tmp/a", "/var/a"),
    ).resolves.toBeUndefined();
    await expect(
      ipc.renameSftpEntry("sftp-session-1", "/tmp/a", "/tmp/b"),
    ).resolves.toBeUndefined();
    await expect(
      ipc.chmodSftpEntry("sftp-session-1", "/tmp/b", 0o640),
    ).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "create_sftp_directory", {
      sessionId: "sftp-session-1",
      remotePath: "/tmp/new",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "delete_sftp_entry", {
      sessionId: "sftp-session-1",
      remotePath: "/tmp/old",
      recursive: true,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "move_sftp_entry", {
      sessionId: "sftp-session-1",
      sourcePath: "/tmp/a",
      targetPath: "/var/a",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "rename_sftp_entry", {
      sessionId: "sftp-session-1",
      sourcePath: "/tmp/a",
      targetPath: "/tmp/b",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(5, "chmod_sftp_entry", {
      sessionId: "sftp-session-1",
      remotePath: "/tmp/b",
      permissions: 0o640,
    });
  });

  it("uses generated connection mutation commands", async () => {
    const config = {
      id: "connection-1",
      groupId: null,
      name: "Production",
      host: "example.com",
      port: 22,
      username: "deploy",
      notes: null,
      color: null,
      authMethod: "password" as const,
      credentialRef: null,
      keyReferenceId: null,
    };
    const settings = {
      connectTimeoutSecs: 12,
      keepAliveSecs: null,
    };
    mocks.invoke.mockResolvedValue(null);

    await expect(ipc.saveConnection(config, settings)).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("save_connection", {
      config,
      settings,
    });

    mocks.invoke.mockResolvedValue(true);
    await expect(ipc.deleteConnection("connection-1")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("delete_connection", {
      id: "connection-1",
    });

    await expect(ipc.recordSuccessfulConnection("connection-1")).resolves.toBe(
      true,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("record_successful_connection", {
      id: "connection-1",
    });

    const group = {
      id: "group-production",
      name: "Production",
      color: "#1677ff",
      sortOrder: 0,
      isCollapsed: false,
      revision: 1,
    };
    mocks.invoke.mockResolvedValue(null);
    await expect(ipc.saveConnectionGroup(group)).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("save_connection_group", {
      group,
    });

    mocks.invoke.mockResolvedValue(true);
    await expect(
      ipc.setConnectionGroupCollapsed("group-production", true),
    ).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_connection_group_collapsed",
      { id: "group-production", isCollapsed: true },
    );

    await expect(ipc.setConnectionFavorite("connection-1", true)).resolves.toBe(
      true,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("set_connection_favorite", {
      id: "connection-1",
      isFavorite: true,
    });

    mocks.invoke.mockResolvedValue(null);
    await expect(
      ipc.reorderConnectionGroups(["group-production", "group-test"]),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("reorder_connection_groups", {
      ids: ["group-production", "group-test"],
    });

    await expect(
      ipc.reorderConnections("group-production", [
        "connection-2",
        "connection-1",
      ]),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("reorder_connections", {
      groupId: "group-production",
      ids: ["connection-2", "connection-1"],
    });

    mocks.invoke.mockResolvedValue(true);
    await expect(ipc.deleteConnectionGroup("group-production")).resolves.toBe(
      true,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("delete_connection_group", {
      id: "group-production",
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
        attemptId: "4f715a34-6a86-4e45-bc2a-8ae680acb614",
        host: "example.com",
        port: 22,
        username: "bxssh",
        password: "secret",
        expectedFingerprint:
          "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        settings: { connectTimeoutSecs: 12, keepAliveSecs: 0 },
        columns: 80,
        rows: 24,
        pixelWidth: 800,
        pixelHeight: 600,
      },
      { onState: vi.fn(), onEvent, onOutput },
    );

    expect(mocks.invoke).toHaveBeenCalledWith("start_password_shell", {
      request: expect.objectContaining({
        username: "bxssh",
        settings: { connectTimeoutSecs: 12, keepAliveSecs: 0 },
        columns: 80,
      }),
      onState: mocks.channels[0],
      onEvent: mocks.channels[1],
      onOutput: mocks.channels[2],
    });

    const output = Uint8Array.from([0x62, 0x78]).buffer;
    mocks.channels[1].onmessage({ type: "exited", code: 0, signal: null });
    mocks.channels[2].onmessage(output);

    expect(onEvent).toHaveBeenCalledWith({
      type: "exited",
      code: 0,
      signal: null,
    });
    expect(onOutput).toHaveBeenCalledWith(output);
  });

  it("opens external URLs only through the reviewed application command", async () => {
    mocks.invoke.mockResolvedValue(null);

    await expect(
      ipc.openExternalUrl("https://docs.example.com/terminal"),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://docs.example.com/terminal",
    });
  });

  it("reads and writes text through the reviewed clipboard commands", async () => {
    mocks.invoke.mockResolvedValueOnce("selected output");

    await expect(ipc.readClipboardText()).resolves.toBe("selected output");
    expect(mocks.invoke).toHaveBeenCalledWith("read_clipboard_text");

    mocks.invoke.mockResolvedValueOnce(null);
    await expect(
      ipc.writeClipboardText("echo bx-ssh"),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("write_clipboard_text", {
      text: "echo bx-ssh",
    });
  });

  it("sends keyboard-interactive answers through the generated command", async () => {
    mocks.invoke.mockResolvedValue({ status: "ok", data: null });

    await expect(
      ipc.respondKeyboardInteractive("attempt-1", ["1234", "otp"]),
    ).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("respond_keyboard_interactive", {
      attemptId: "attempt-1",
      responses: ["1234", "otp"],
    });
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
