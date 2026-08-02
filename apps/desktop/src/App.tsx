import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Segmented,
  Tooltip,
} from "antd";
import {
  Circle,
  Fingerprint,
  FolderOpen,
  PlugZap,
  ScanSearch,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import {
  TerminalPane,
  type TerminalHandle,
  type TerminalViewport,
} from "./components/TerminalPane";
import {
  SftpPane,
  type RemoteDirectoryListing,
  type SftpTransferResult,
  type TransferSummary,
} from "./components/SftpPane";

interface AppInfo {
  name: string;
  version: string;
}

interface HostKeyInfo {
  algorithm: string;
  fingerprintSha256: string;
}

interface StartShellResponse {
  sessionId: string;
  hostKey: HostKeyInfo;
}

interface StartSftpResponse {
  sessionId: string;
  hostKey: HostKeyInfo;
  directory: RemoteDirectoryListing;
}

type TerminalEvent =
  | { type: "exited"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message: string };

interface CommandError {
  code?: string;
  message?: string;
}

type ConnectionState =
  | "idle"
  | "probing"
  | "ready"
  | "connecting"
  | "connected"
  | "closing"
  | "disconnected"
  | "failed";

type WorkspaceMode = "terminal" | "sftp";

const fallbackInfo: AppInfo = {
  name: "BX SSH",
  version: "0.1.0",
};

const fallbackViewport: TerminalViewport = {
  columns: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};

const MEMORY_USAGE_RECOVERY_DELAY_MS = 60_000;

export function App() {
  const [appInfo, setAppInfo] = useState(fallbackInfo);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hostKey, setHostKey] = useState<HostKeyInfo | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("terminal");
  const [sftpSessionId, setSftpSessionId] = useState<string | null>(null);
  const [sftpDirectory, setSftpDirectory] =
    useState<RemoteDirectoryListing | null>(null);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpTransferResult, setSftpTransferResult] =
    useState<SftpTransferResult | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sftpSessionIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resizeTimerRef = useRef<number | null>(null);
  const memoryUsageTimerRef = useRef<number | null>(null);
  const connectionAttemptRef = useRef(0);

  const enableLowMemoryUsage = useCallback(async () => {
    if (memoryUsageTimerRef.current !== null) {
      window.clearTimeout(memoryUsageTimerRef.current);
      memoryUsageTimerRef.current = null;
    }
    await setWebviewMemoryUsage(true);
  }, []);

  const scheduleNormalMemoryUsage = useCallback(() => {
    if (memoryUsageTimerRef.current !== null) {
      window.clearTimeout(memoryUsageTimerRef.current);
    }
    memoryUsageTimerRef.current = window.setTimeout(() => {
      memoryUsageTimerRef.current = null;
      void setWebviewMemoryUsage(false);
    }, MEMORY_USAGE_RECOVERY_DELAY_MS);
  }, []);

  useEffect(() => {
    let active = true;

    void invoke<AppInfo>("app_info")
      .then((info) => {
        if (active) {
          setAppInfo(info);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sftpSessionIdRef.current = sftpSessionId;
  }, [sftpSessionId]);

  useEffect(
    () => () => {
      connectionAttemptRef.current += 1;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      if (memoryUsageTimerRef.current !== null) {
        window.clearTimeout(memoryUsageTimerRef.current);
      }
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId) {
        void invoke("close_terminal_session", {
          sessionId: activeSessionId,
        });
      }
      const activeSftpSessionId = sftpSessionIdRef.current;
      if (activeSftpSessionId) {
        void invoke("close_sftp_session", {
          sessionId: activeSftpSessionId,
        });
      }
    },
    [],
  );

  const resetHostTrust = useCallback(() => {
    setHostKey(null);
    setTrusted(false);
    setErrorMessage(null);
    setConnectionState("idle");
  }, []);

  const probeHost = async () => {
    setConnectionState("probing");
    setErrorMessage(null);
    setHostKey(null);
    setTrusted(false);

    try {
      const result = await invoke<HostKeyInfo>("probe_ssh_host", {
        request: { host, port },
      });
      setHostKey(result);
      setConnectionState("ready");
    } catch (error) {
      setErrorMessage(errorText(error));
      setConnectionState("failed");
    }
  };

  const connectTerminal = async () => {
    if (!hostKey || !trusted || !username || !password) {
      return;
    }

    setConnectionState("connecting");
    setErrorMessage(null);
    terminalRef.current?.reset();

    const attempt = ++connectionAttemptRef.current;
    let ended = false;
    let acknowledgementSessionId: string | null = null;
    let receivedSequence = 0;
    let processedSequence = 0;
    let queuedSequence = 0;
    let acknowledgementQueue = Promise.resolve();

    const queueAcknowledgement = (sequence: number) => {
      processedSequence = Math.max(processedSequence, sequence);
      const activeSessionId = acknowledgementSessionId;
      if (!activeSessionId || processedSequence <= queuedSequence) {
        return;
      }

      const sequenceToAcknowledge = processedSequence;
      queuedSequence = sequenceToAcknowledge;
      acknowledgementQueue = acknowledgementQueue
        .then(() =>
          invoke<void>("acknowledge_terminal_output", {
            sessionId: activeSessionId,
            sequence: sequenceToAcknowledge,
          }),
        )
        .catch((error: unknown) => {
          if (
            connectionAttemptRef.current === attempt &&
            sessionIdRef.current === activeSessionId &&
            !isClosedSessionError(error)
          ) {
            setErrorMessage(errorText(error));
            setConnectionState("failed");
          }
        });
    };

    const eventChannel = new Channel<TerminalEvent>();
    eventChannel.onmessage = (event) => {
      if (connectionAttemptRef.current !== attempt) {
        return;
      }

      ended = true;
      void enableLowMemoryUsage();
      if (event.type === "error") {
        setErrorMessage(event.message);
        setConnectionState("failed");
        return;
      }

      sessionIdRef.current = null;
      setSessionId(null);
      setConnectionState("disconnected");
    };
    const outputChannel = new Channel<ArrayBuffer>();
    outputChannel.onmessage = (data) => {
      const sequence = ++receivedSequence;
      const acknowledge = () => queueAcknowledgement(sequence);

      if (connectionAttemptRef.current !== attempt) {
        acknowledge();
        return;
      }

      const terminal = terminalRef.current;
      if (terminal) {
        terminal.write(new Uint8Array(data), acknowledge);
      } else {
        acknowledge();
      }
    };

    const viewport = terminalRef.current?.viewport() ?? fallbackViewport;

    try {
      await enableLowMemoryUsage();
      const response = await invoke<StartShellResponse>(
        "start_password_shell",
        {
          request: {
            host,
            port,
            username,
            password,
            expectedFingerprint: hostKey.fingerprintSha256,
            ...viewport,
          },
          onEvent: eventChannel,
          onOutput: outputChannel,
        },
      );
      acknowledgementSessionId = response.sessionId;
      queueAcknowledgement(processedSequence);

      if (connectionAttemptRef.current !== attempt) {
        void invoke("close_terminal_session", {
          sessionId: response.sessionId,
        }).catch(() => undefined);
        return;
      }

      setPassword("");
      if (ended) {
        void invoke("close_terminal_session", {
          sessionId: response.sessionId,
        }).catch(() => undefined);
        return;
      }

      sessionIdRef.current = response.sessionId;
      scheduleNormalMemoryUsage();
      setSessionId(response.sessionId);
      setHostKey(response.hostKey);
      setConnectionState("connected");
      terminalRef.current?.focus();
    } catch (error) {
      if (connectionAttemptRef.current !== attempt) {
        return;
      }
      setPassword("");
      setErrorMessage(errorText(error));
      setConnectionState("failed");
    }
  };

  const connectSftp = async () => {
    if (!hostKey || !trusted || !username || !password) {
      return;
    }

    setConnectionState("connecting");
    setErrorMessage(null);
    setSftpTransferResult(null);
    terminalRef.current?.reset();
    const attempt = ++connectionAttemptRef.current;

    try {
      await enableLowMemoryUsage();
      const response = await invoke<StartSftpResponse>("start_password_sftp", {
        request: {
          host,
          port,
          username,
          password,
          expectedFingerprint: hostKey.fingerprintSha256,
          initialPath: ".",
        },
      });
      if (connectionAttemptRef.current !== attempt) {
        void invoke("close_sftp_session", {
          sessionId: response.sessionId,
        }).catch(() => undefined);
        return;
      }

      sftpSessionIdRef.current = response.sessionId;
      setPassword("");
      scheduleNormalMemoryUsage();
      setSftpSessionId(response.sessionId);
      setSftpDirectory(response.directory);
      setHostKey(response.hostKey);
      setConnectionState("connected");
    } catch (error) {
      if (connectionAttemptRef.current !== attempt) {
        return;
      }
      setPassword("");
      setErrorMessage(errorText(error));
      setConnectionState("failed");
    }
  };

  const connectCurrentMode = async () => {
    if (workspaceMode === "terminal") {
      await connectTerminal();
    } else {
      await connectSftp();
    }
  };

  const closeSession = async () => {
    const activeSessionId =
      workspaceMode === "terminal" ? sessionId : sftpSessionId;
    if (!activeSessionId) {
      return;
    }

    setConnectionState("closing");
    try {
      if (workspaceMode === "terminal") {
        await invoke("close_terminal_session", { sessionId: activeSessionId });
      } else {
        await invoke("close_sftp_session", { sessionId: activeSessionId });
        sftpSessionIdRef.current = null;
        setSftpSessionId(null);
        setSftpDirectory(null);
        setConnectionState("disconnected");
        void enableLowMemoryUsage();
      }
    } catch (error) {
      setErrorMessage(errorText(error));
      if (workspaceMode === "terminal") {
        sessionIdRef.current = null;
        setSessionId(null);
      } else {
        sftpSessionIdRef.current = null;
        setSftpSessionId(null);
        setSftpDirectory(null);
      }
      setConnectionState("disconnected");
    }
  };

  const navigateSftp = async (path: string) => {
    const activeSessionId = sftpSessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    setSftpBusy(true);
    setErrorMessage(null);
    try {
      const directory = await invoke<RemoteDirectoryListing>(
        "list_sftp_directory",
        { sessionId: activeSessionId, path },
      );
      setSftpDirectory(directory);
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setSftpBusy(false);
    }
  };

  const refreshSftp = async () => {
    await navigateSftp(sftpDirectory?.path ?? ".");
  };

  const uploadSftp = async (localPath: string, remotePath: string) => {
    const activeSessionId = sftpSessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    setSftpBusy(true);
    setErrorMessage(null);
    setSftpTransferResult(null);
    try {
      const summary = await invoke<TransferSummary>("upload_sftp_file", {
        sessionId: activeSessionId,
        localPath,
        remotePath,
      });
      setSftpTransferResult({ direction: "upload", summary });
      const directory = await invoke<RemoteDirectoryListing>(
        "list_sftp_directory",
        { sessionId: activeSessionId, path: sftpDirectory?.path ?? "." },
      );
      setSftpDirectory(directory);
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setSftpBusy(false);
    }
  };

  const downloadSftp = async (remotePath: string, localPath: string) => {
    const activeSessionId = sftpSessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    setSftpBusy(true);
    setErrorMessage(null);
    setSftpTransferResult(null);
    try {
      const summary = await invoke<TransferSummary>("download_sftp_file", {
        sessionId: activeSessionId,
        remotePath,
        localPath,
      });
      setSftpTransferResult({ direction: "download", summary });
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setSftpBusy(false);
    }
  };

  const writeTerminal = useCallback((data: string) => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) {
      return;
    }

    inputQueueRef.current = inputQueueRef.current
      .then(() =>
        invoke<void>("write_terminal", {
          sessionId: activeSessionId,
          data,
        }),
      )
      .catch((error: unknown) => {
        setErrorMessage(errorText(error));
        setConnectionState("failed");
      });
  }, []);

  const resizeTerminal = useCallback((viewport: TerminalViewport) => {
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
    }

    resizeTimerRef.current = window.setTimeout(() => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) {
        return;
      }

      void invoke("resize_terminal", {
        sessionId: activeSessionId,
        ...viewport,
      }).catch((error: unknown) => {
        setErrorMessage(errorText(error));
        setConnectionState("failed");
      });
    }, 80);
  }, []);

  const busy = ["probing", "connecting", "closing"].includes(connectionState);
  const connected = connectionState === "connected";
  const activeSessionId =
    workspaceMode === "terminal" ? sessionId : sftpSessionId;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <SquareTerminal size={17} strokeWidth={2.1} />
          </span>
          <span>{appInfo.name}</span>
        </div>
        <div className="topbar-session">
          <span className={`connection-dot state-${connectionState}`} />
          <span>{connectionLabel(connectionState)}</span>
          <span className="version">v{appInfo.version}</span>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="SSH 连接验证">
          <div className="sidebar-heading">
            <h1>连接验证</h1>
            <span>
              {workspaceMode === "terminal" ? "SSH / PTY" : "SFTP v3"}
            </span>
          </div>

          <Segmented<WorkspaceMode>
            className="workspace-mode"
            block
            value={workspaceMode}
            disabled={connected || busy}
            options={[
              {
                value: "terminal",
                label: "终端",
                icon: <SquareTerminal size={14} />,
              },
              {
                value: "sftp",
                label: "SFTP",
                icon: <FolderOpen size={14} />,
              },
            ]}
            onChange={(value) => {
              setWorkspaceMode(value);
              setErrorMessage(null);
              setConnectionState(hostKey ? "ready" : "idle");
            }}
          />

          <div className="connection-form">
            <label className="field-group">
              <span className="field-label">主机</span>
              <Input
                value={host}
                disabled={connected || busy}
                onChange={(event) => {
                  setHost(event.target.value);
                  resetHostTrust();
                }}
                placeholder="hostname 或 IP"
              />
            </label>

            <label className="field-group">
              <span className="field-label">端口</span>
              <InputNumber
                value={port}
                min={1}
                max={65535}
                controls={false}
                disabled={connected || busy}
                onChange={(value) => {
                  setPort(value ?? 22);
                  resetHostTrust();
                }}
              />
            </label>

            <Button
              icon={<ScanSearch size={15} />}
              loading={connectionState === "probing"}
              disabled={!host || connected || busy}
              onClick={() => void probeHost()}
              block
            >
              检测主机指纹
            </Button>

            {hostKey && (
              <section className="fingerprint-panel" aria-label="主机指纹">
                <div className="fingerprint-title">
                  <Fingerprint size={14} />
                  <span>{hostKey.algorithm}</span>
                </div>
                <code>{hostKey.fingerprintSha256}</code>
                <Checkbox
                  checked={trusted}
                  disabled={connected || busy}
                  onChange={(event) => setTrusted(event.target.checked)}
                >
                  信任此主机指纹
                </Checkbox>
              </section>
            )}

            <label className="field-group">
              <span className="field-label">用户名</span>
              <Input
                value={username}
                autoComplete="username"
                disabled={connected || busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="field-group">
              <span className="field-label">密码</span>
              <Input.Password
                value={password}
                autoComplete="current-password"
                disabled={connected || busy}
                onChange={(event) => setPassword(event.target.value)}
                onPressEnter={() => void connectCurrentMode()}
              />
            </label>

            {!activeSessionId ? (
              <Button
                type="primary"
                icon={<PlugZap size={15} />}
                loading={connectionState === "connecting"}
                disabled={
                  busy || !hostKey || !trusted || !username || !password
                }
                onClick={() => void connectCurrentMode()}
                block
              >
                连接
              </Button>
            ) : (
              <Button
                danger
                icon={<Unplug size={15} />}
                loading={connectionState === "closing"}
                disabled={workspaceMode === "sftp" && sftpBusy}
                onClick={() => void closeSession()}
                block
              >
                断开
              </Button>
            )}
          </div>

          {errorMessage && (
            <Alert
              className="connection-error"
              type="error"
              showIcon
              message={connected ? "操作失败" : "连接失败"}
              description={errorMessage}
              closable
              onClose={() => setErrorMessage(null)}
            />
          )}
        </aside>

        {workspaceMode === "terminal" ? (
          <main className="terminal-workspace">
            <div className="terminal-toolbar">
              <div className="terminal-title">
                <SquareTerminal size={14} />
                <span>终端</span>
              </div>
              <span className="endpoint-label">
                {connected ? `${username}@${host}:${port}` : "未连接"}
              </span>
            </div>
            <div className="terminal-stage">
              <TerminalPane
                ref={terminalRef}
                connected={connected}
                onData={writeTerminal}
                onResize={resizeTerminal}
              />
              {!connected && (
                <div className="terminal-empty" aria-live="polite">
                  <SquareTerminal size={36} strokeWidth={1.3} />
                  <span>{connectionLabel(connectionState)}</span>
                </div>
              )}
            </div>
          </main>
        ) : (
          <main className="sftp-workspace">
            <SftpPane
              busy={sftpBusy}
              connected={connected}
              directory={sftpDirectory}
              endpoint={`${username}@${host}:${port}`}
              transferResult={sftpTransferResult}
              onNavigate={navigateSftp}
              onRefresh={refreshSftp}
              onUpload={uploadSftp}
              onDownload={downloadSftp}
            />
          </main>
        )}
      </div>

      <footer className="statusbar">
        <span className="status-item">
          <Circle
            className={`status-dot state-${connectionState}`}
            size={7}
            fill="currentColor"
          />
          {connectionLabel(connectionState)}
        </span>
        <span className="status-spacer" />
        <Tooltip title={workspaceMode === "terminal" ? "终端类型" : "协议版本"}>
          <span>
            {workspaceMode === "terminal" ? "xterm-256color" : "SFTP v3"}
          </span>
        </Tooltip>
        <span className="status-divider" />
        <span>UTF-8</span>
      </footer>
    </div>
  );
}

function connectionLabel(state: ConnectionState): string {
  const labels: Record<ConnectionState, string> = {
    idle: "就绪",
    probing: "正在检测指纹",
    ready: "等待连接",
    connecting: "正在连接",
    connected: "已连接",
    closing: "正在断开",
    disconnected: "已断开",
    failed: "连接失败",
  };

  return labels[state];
}

function errorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const commandError = error as CommandError;
    if (typeof commandError.message === "string") {
      return commandError.message;
    }
  }
  return "SSH 操作失败";
}

function isClosedSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as CommandError).code;
  return code === "session_not_found" || code === "session_closed";
}

async function setWebviewMemoryUsage(low: boolean): Promise<void> {
  await invoke("set_webview_memory_usage", { low }).catch(() => undefined);
}
