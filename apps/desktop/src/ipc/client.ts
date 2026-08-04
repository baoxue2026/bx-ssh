import { Channel, invoke } from "@tauri-apps/api/core";
import {
  commands,
  type CommandError,
  type CommandErrorCode,
  type ProbeHostRequest,
  type Result,
  type StartShellRequest,
  type StartShellResponse,
  type TerminalEvent,
  type UpdateEvent,
} from "./bindings";

const IPC_TRANSPORT_ERROR = "ipc_transport_error" as const;

export type IpcErrorCode = CommandErrorCode | typeof IPC_TRANSPORT_ERROR;

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IpcError";
    this.code = code;
  }

  static from(error: unknown): IpcError {
    if (error instanceof IpcError) {
      return error;
    }
    if (isCommandError(error)) {
      return new IpcError(error.code, error.message, error);
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
  probeSshHost: (request: ProbeHostRequest) =>
    unwrap(() => commands.probeSshHost(request)),
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
  startPasswordSftp: (
    request: Parameters<typeof commands.startPasswordSftp>[0],
  ) => unwrap(() => commands.startPasswordSftp(request)),
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
        onEvent: createChannel(channels.onEvent),
        onOutput: createChannel(channels.onOutput),
      }),
    ),
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
