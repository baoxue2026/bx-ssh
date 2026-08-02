import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Alert, Button, Checkbox, Input, InputNumber, Tooltip } from "antd";
import {
  Circle,
  Fingerprint,
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
  const terminalRef = useRef<TerminalHandle>(null);
  const sessionIdRef = useRef<string | null>(null);
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

  const connect = async () => {
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

  const closeSession = async () => {
    if (!sessionId) {
      return;
    }

    setConnectionState("closing");
    try {
      await invoke("close_terminal_session", { sessionId });
    } catch (error) {
      setErrorMessage(errorText(error));
      setSessionId(null);
      setConnectionState("disconnected");
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
            <span>SSH / PTY</span>
          </div>

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
                onPressEnter={() => void connect()}
              />
            </label>

            {!sessionId ? (
              <Button
                type="primary"
                icon={<PlugZap size={15} />}
                loading={connectionState === "connecting"}
                disabled={
                  busy || !hostKey || !trusted || !username || !password
                }
                onClick={() => void connect()}
                block
              >
                连接
              </Button>
            ) : (
              <Button
                danger
                icon={<Unplug size={15} />}
                loading={connectionState === "closing"}
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
              message="连接失败"
              description={errorMessage}
              closable
              onClose={() => setErrorMessage(null)}
            />
          )}
        </aside>

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
        <Tooltip title="终端类型">
          <span>xterm-256color</span>
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
