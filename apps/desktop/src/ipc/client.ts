import { Channel, invoke } from "@tauri-apps/api/core";
import {
  commands,
  type CommandError,
  type CommandErrorCode,
  type ConnectionConfig,
  type ConnectionGroup,
  type ConnectionSettingsOverride,
  type HostKeyInfo,
  type KeyboardInteractiveEvent,
  type OpenSshImportRequest,
  type ProbeHostRequest,
  type Result,
  type SshConnectionEvent,
  type SshConnectionStage,
  type StartSftpRequest,
  type StartSftpResponse,
  type StartPrivateKeySftpRequest,
  type StartPrivateKeyShellRequest,
  type StartKeyboardInteractiveShellRequest,
  type StartShellRequest,
  type StartShellResponse,
  type TerminalEvent,
  type UpdateEvent,
} from "./bindings";

const IPC_TRANSPORT_ERROR = "ipc_transport_error" as const;

export type IpcErrorCode = CommandErrorCode | typeof IPC_TRANSPORT_ERROR;

export class IpcError extends Error {
  readonly code: IpcErrorCode;
  readonly stage: SshConnectionStage | null;

  constructor(
    code: IpcErrorCode,
    message: string,
    cause?: unknown,
    stage: SshConnectionStage | null = null,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IpcError";
    this.code = code;
    this.stage = stage;
  }

  static from(error: unknown): IpcError {
    if (error instanceof IpcError) {
      return error;
    }
    if (isCommandError(error)) {
      return new IpcError(
        error.code,
        error.message,
        error,
        error.stage ?? null,
      );
    }
    if (error instanceof Error) {
      return new IpcError(IPC_TRANSPORT_ERROR, error.message, error);
    }
    if (typeof error === "string") {
      return new IpcError(IPC_TRANSPORT_ERROR, error, error);
    }
    return new IpcError(IPC_TRANSPORT_ERROR, "IPC request failed", error);
  }
}

type TerminalSize = Pick<
  StartShellRequest,
  "columns" | "rows" | "pixelWidth" | "pixelHeight"
>;

interface TerminalChannels {
  onState(event: SshConnectionEvent): void;
  onEvent(event: TerminalEvent): void;
  onOutput(data: ArrayBuffer): void;
}

interface KeyboardInteractiveChannels {
  onAuth(event: KeyboardInteractiveEvent): void;
  onState(event: SshConnectionEvent): void;
  onEvent(event: TerminalEvent): void;
  onOutput(data: ArrayBuffer): void;
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw IpcError.from(error);
  }
}

async function unwrap<T>(
  operation: () => Promise<Result<T, CommandError>>,
): Promise<T> {
  const result = await call(operation);
  if (result.status === "error") {
    throw IpcError.from(result.error);
  }
  return result.data;
}

async function unwrapVoid(
  operation: () => Promise<Result<null, CommandError>>,
): Promise<void> {
  await unwrap(operation);
}

function createChannel<T>(onMessage: (message: T) => void): Channel<T> {
  const channel = new Channel<T>();
  channel.onmessage = onMessage;
  return channel;
}

export const ipc = {
  appInfo: () => call(() => commands.appInfo()),
  readClipboardText: () => unwrap(() => commands.readClipboardText()),
  writeClipboardText: (text: string) =>
    unwrapVoid(() => commands.writeClipboardText(text)),
  openExternalUrl: (url: string) =>
    unwrapVoid(() => commands.openExternalUrl(url)),
  listConnections: () => unwrap(() => commands.listConnections()),
  getConnection: (id: string) => unwrap(() => commands.getConnection(id)),
  previewOpenSshConfig: (path: string | null) =>
    unwrap(() => commands.previewOpensshConfig(path)),
  importOpenSshConnections: (request: OpenSshImportRequest) =>
    unwrap(() => commands.importOpensshConnections(request)),
  saveConnection: (
    config: ConnectionConfig,
    settings: ConnectionSettingsOverride,
  ) => unwrapVoid(() => commands.saveConnection(config, settings)),
  deleteConnection: (id: string) => unwrap(() => commands.deleteConnection(id)),
  recordSuccessfulConnection: (id: string) =>
    unwrap(() => commands.recordSuccessfulConnection(id)),
  saveConnectionGroup: (group: ConnectionGroup) =>
    unwrapVoid(() => commands.saveConnectionGroup(group)),
  deleteConnectionGroup: (id: string) =>
    unwrap(() => commands.deleteConnectionGroup(id)),
  setConnectionGroupCollapsed: (id: string, isCollapsed: boolean) =>
    unwrap(() => commands.setConnectionGroupCollapsed(id, isCollapsed)),
  reorderConnectionGroups: (ids: string[]) =>
    unwrapVoid(() => commands.reorderConnectionGroups(ids)),
  setConnectionFavorite: (id: string, isFavorite: boolean) =>
    unwrap(() => commands.setConnectionFavorite(id, isFavorite)),
  reorderConnections: (groupId: string | null, ids: string[]) =>
    unwrapVoid(() => commands.reorderConnections(groupId, ids)),
  probeSshHost: (request: ProbeHostRequest) =>
    unwrap(() => commands.probeSshHost(request)),
  getKnownHost: (host: string, port: number) =>
    unwrap(() => commands.getKnownHost(host, port)),
  getPasswordCredential: (credentialRef: string) =>
    unwrap(() => commands.getPasswordCredential(credentialRef)),
  savePasswordCredential: (credentialRef: string, password: string) =>
    unwrapVoid(() => commands.savePasswordCredential(credentialRef, password)),
  deletePasswordCredential: (credentialRef: string) =>
    unwrapVoid(() => commands.deletePasswordCredential(credentialRef)),
  trustHostFingerprint: (request: {
    host: string;
    port: number;
    hostKey: HostKeyInfo;
  }) => unwrapVoid(() => commands.trustHostFingerprint(request)),
  writeTerminal: (sessionId: string, data: string) =>
    unwrapVoid(() => commands.writeTerminal(sessionId, data)),
  resizeTerminal: (sessionId: string, size: TerminalSize) =>
    unwrapVoid(() =>
      commands.resizeTerminal(
        sessionId,
        size.columns,
        size.rows,
        size.pixelWidth,
        size.pixelHeight,
      ),
    ),
  acknowledgeTerminalOutput: (sessionId: string, sequence: number) =>
    unwrapVoid(() => commands.acknowledgeTerminalOutput(sessionId, sequence)),
  closeTerminalSession: (sessionId: string) =>
    unwrapVoid(() => commands.closeTerminalSession(sessionId)),
  cancelSshConnection: (attemptId: string) =>
    unwrap(() => commands.cancelSshConnection(attemptId)),
  startPasswordSftp: (
    request: StartSftpRequest,
    onState: (event: SshConnectionEvent) => void,
  ) =>
    call(() =>
      invoke<StartSftpResponse>("start_password_sftp", {
        request,
        onState: createChannel(onState),
      }),
    ),
  startPrivateKeySftp: (
    request: StartPrivateKeySftpRequest,
    onState: (event: SshConnectionEvent) => void,
  ) =>
    call(() =>
      invoke<StartSftpResponse>("start_private_key_sftp", {
        request,
        onState: createChannel(onState),
      }),
    ),
  listSftpDirectory: (sessionId: string, path: string) =>
    unwrap(() => commands.listSftpDirectory(sessionId, path)),
  uploadSftpFile: (
    sessionId: string,
    localPath: string,
    remotePath: string,
    language: string,
  ) =>
    unwrap(() =>
      commands.uploadSftpFile(sessionId, localPath, remotePath, language),
    ),
  downloadSftpFile: (
    sessionId: string,
    remotePath: string,
    localPath: string,
    language: string,
  ) =>
    unwrap(() =>
      commands.downloadSftpFile(sessionId, remotePath, localPath, language),
    ),
  hashRemoteSftpFile: (sessionId: string, remotePath: string) =>
    unwrap(() => commands.hashRemoteSftpFile(sessionId, remotePath)),
  closeSftpSession: (sessionId: string) =>
    unwrapVoid(() => commands.closeSftpSession(sessionId)),
  setWebviewMemoryUsage: (low: boolean) =>
    unwrapVoid(() => commands.setWebviewMemoryUsage(low)),
  checkForUpdate: () => unwrap(() => commands.checkForUpdate()),
  confirmAppExit: () => unwrapVoid(() => commands.confirmAppExit()),
  startPasswordShell: (
    request: StartShellRequest,
    channels: TerminalChannels,
  ) =>
    call(() =>
      invoke<StartShellResponse>("start_password_shell", {
        request,
        onState: createChannel(channels.onState),
        onEvent: createChannel(channels.onEvent),
        onOutput: createChannel(channels.onOutput),
      }),
    ),
  startPrivateKeyShell: (
    request: StartPrivateKeyShellRequest,
    channels: TerminalChannels,
  ) =>
    call(() =>
      invoke<StartShellResponse>("start_private_key_shell", {
        request,
        onState: createChannel(channels.onState),
        onEvent: createChannel(channels.onEvent),
        onOutput: createChannel(channels.onOutput),
      }),
    ),
  startKeyboardInteractiveShell: (
    request: StartKeyboardInteractiveShellRequest,
    channels: KeyboardInteractiveChannels,
  ) =>
    call(() =>
      invoke<StartShellResponse>("start_keyboard_interactive_shell", {
        request,
        onAuth: createChannel(channels.onAuth),
        onState: createChannel(channels.onState),
        onEvent: createChannel(channels.onEvent),
        onOutput: createChannel(channels.onOutput),
      }),
    ),
  respondKeyboardInteractive: (attemptId: string, responses: string[]) =>
    unwrapVoid(() => commands.respondKeyboardInteractive(attemptId, responses)),
  installUpdate: (
    expectedVersion: string,
    onEvent: (event: UpdateEvent) => void,
  ) =>
    call(() =>
      invoke<void>("install_update", {
        expectedVersion,
        onEvent: createChannel(onEvent),
      }),
    ),
};

function isCommandError(error: unknown): error is CommandError {
  if (!error || typeof error !== "object") {
    return false;
  }
  const value = error as { code?: unknown; message?: unknown };
  return typeof value.code === "string" && typeof value.message === "string";
}
