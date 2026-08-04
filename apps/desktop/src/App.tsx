import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TFunction } from "i18next";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
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
import { useTranslation } from "react-i18next";
import {
  TerminalPane,
  type TerminalHandle,
  type TerminalViewport,
} from "./components/TerminalPane";
import { SftpPane, type SftpTransferResult } from "./components/SftpPane";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { IpcError, ipc } from "./ipc/client";
import type {
  AppInfo,
  AppMenuAction,
  ExitImpact,
  HostKeyInfo,
  RemoteDirectoryListing,
  TerminalEvent,
} from "./ipc/bindings";
import { useUiPreferences } from "./ui/preferenceContext";

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
const EXIT_REQUESTED_EVENT = "app-exit-requested";
const APP_MENU_ACTION_EVENT = "app-menu-action";

export function App() {
  const { t } = useTranslation();
  const { language } = useUiPreferences();
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
  const [exitImpact, setExitImpact] = useState<ExitImpact | null>(null);
  const [exitPending, setExitPending] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const [updateRequestId, setUpdateRequestId] = useState(0);
  const terminalRef = useRef<TerminalHandle>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sftpSessionIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resizeTimerRef = useRef<number | null>(null);
  const memoryUsageTimerRef = useRef<number | null>(null);
  const connectionAttemptRef = useRef(0);
  const exitCancelButtonRef = useRef<HTMLButtonElement>(null);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const hostKeyRef = useRef<HostKeyInfo | null>(null);
  const localizedErrorText = useCallback(
    (error: unknown) => errorText(error, t("errors.sshOperation")),
    [t],
  );

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

  const selectWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    if (
      ["probing", "connecting", "connected", "closing"].includes(
        connectionStateRef.current,
      )
    ) {
      return;
    }

    setWorkspaceMode(mode);
    setErrorMessage(null);
    setConnectionState(hostKeyRef.current ? "ready" : "idle");
  }, []);

  useEffect(() => {
    let active = true;

    void ipc
      .appInfo()
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
    let disposed = false;
    let removeListener: (() => void) | undefined;

    void listen<AppMenuAction>(APP_MENU_ACTION_EVENT, (event) => {
      if (event.payload === "check-for-updates") {
        setUpdateRequestId((current) => current + 1);
        return;
      }

      selectWorkspaceMode(
        event.payload === "show-terminal" ? "terminal" : "sftp",
      );
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          removeListener = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [selectWorkspaceMode]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      if (!event.shiftKey && (event.key === "1" || event.key === "2")) {
        event.preventDefault();
        selectWorkspaceMode(event.key === "1" ? "terminal" : "sftp");
        return;
      }

      if (!event.shiftKey) return;
      if (event.key.toLowerCase() === "u") {
        event.preventDefault();
        setUpdateRequestId((current) => current + 1);
      } else if (event.key.toLowerCase() === "q") {
        event.preventDefault();
        void getCurrentWindow()
          .close()
          .catch(() => undefined);
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [selectWorkspaceMode]);

  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | undefined;

    void listen<ExitImpact>(EXIT_REQUESTED_EVENT, (event) => {
      setExitImpact(event.payload);
      setExitPending(false);
      setExitError(null);
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          removeListener = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sftpSessionIdRef.current = sftpSessionId;
  }, [sftpSessionId]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    hostKeyRef.current = hostKey;
  }, [hostKey]);

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
        void ipc.closeTerminalSession(activeSessionId);
      }
      const activeSftpSessionId = sftpSessionIdRef.current;
      if (activeSftpSessionId) {
        void ipc.closeSftpSession(activeSftpSessionId);
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
      const result = await ipc.probeSshHost({ host, port });
      setHostKey(result);
      setConnectionState("ready");
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
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
          ipc.acknowledgeTerminalOutput(activeSessionId, sequenceToAcknowledge),
        )
        .catch((error: unknown) => {
          if (
            connectionAttemptRef.current === attempt &&
            sessionIdRef.current === activeSessionId &&
            !isClosedSessionError(error)
          ) {
            setErrorMessage(localizedErrorText(error));
            setConnectionState("failed");
          }
        });
    };

    const handleTerminalEvent = (event: TerminalEvent) => {
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
    const handleTerminalOutput = (data: ArrayBuffer) => {
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
      const response = await ipc.startPasswordShell(
        {
          host,
          port,
          username,
          password,
          expectedFingerprint: hostKey.fingerprintSha256,
          ...viewport,
        },
        {
          onEvent: handleTerminalEvent,
          onOutput: handleTerminalOutput,
        },
      );
      acknowledgementSessionId = response.sessionId;
      queueAcknowledgement(processedSequence);

      if (connectionAttemptRef.current !== attempt) {
        void ipc
          .closeTerminalSession(response.sessionId)
          .catch(() => undefined);
        return;
      }

      setPassword("");
      if (ended) {
        void ipc
          .closeTerminalSession(response.sessionId)
          .catch(() => undefined);
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
      setErrorMessage(localizedErrorText(error));
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
      const response = await ipc.startPasswordSftp({
        host,
        port,
        username,
        password,
        expectedFingerprint: hostKey.fingerprintSha256,
        initialPath: ".",
      });
      if (connectionAttemptRef.current !== attempt) {
        void ipc.closeSftpSession(response.sessionId).catch(() => undefined);
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
      setErrorMessage(localizedErrorText(error));
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
        await ipc.closeTerminalSession(activeSessionId);
      } else {
        await ipc.closeSftpSession(activeSessionId);
        sftpSessionIdRef.current = null;
        setSftpSessionId(null);
        setSftpDirectory(null);
        setConnectionState("disconnected");
        void enableLowMemoryUsage();
      }
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
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
      const directory = await ipc.listSftpDirectory(activeSessionId, path);
      setSftpDirectory(directory);
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
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
      const summary = await ipc.uploadSftpFile(
        activeSessionId,
        localPath,
        remotePath,
        language,
      );
      setSftpTransferResult({ direction: "upload", summary });
      const directory = await ipc.listSftpDirectory(
        activeSessionId,
        sftpDirectory?.path ?? ".",
      );
      setSftpDirectory(directory);
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
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
      const summary = await ipc.downloadSftpFile(
        activeSessionId,
        remotePath,
        localPath,
        language,
      );
      setSftpTransferResult({ direction: "download", summary });
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
    } finally {
      setSftpBusy(false);
    }
  };

  const writeTerminal = useCallback(
    (data: string) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) {
        return;
      }

      inputQueueRef.current = inputQueueRef.current
        .then(() => ipc.writeTerminal(activeSessionId, data))
        .catch((error: unknown) => {
          setErrorMessage(localizedErrorText(error));
          setConnectionState("failed");
        });
    },
    [localizedErrorText],
  );

  const resizeTerminal = useCallback(
    (viewport: TerminalViewport) => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }

      resizeTimerRef.current = window.setTimeout(() => {
        const activeSessionId = sessionIdRef.current;
        if (!activeSessionId) {
          return;
        }

        void ipc.resizeTerminal(activeSessionId, viewport).catch((error) => {
          setErrorMessage(localizedErrorText(error));
          setConnectionState("failed");
        });
      }, 80);
    },
    [localizedErrorText],
  );

  const confirmAppExit = async () => {
    setExitPending(true);
    setExitError(null);
    try {
      await ipc.confirmAppExit();
      setExitImpact(null);
    } catch (error) {
      setExitPending(false);
      setExitError(localizedErrorText(error));
    }
  };

  const cancelAppExit = () => {
    if (exitPending) {
      return;
    }
    setExitImpact(null);
    setExitError(null);
  };

  const busy = ["probing", "connecting", "closing"].includes(connectionState);
  const connected = connectionState === "connected";
  const activeSessionId =
    workspaceMode === "terminal" ? sessionId : sftpSessionId;

  return (
    <div className="app-shell">
      <WindowTitleBar
        appName={appInfo.name}
        connectionLabel={connectionLabel(connectionState, t)}
        connectionState={connectionState}
        onCheckForUpdates={() => setUpdateRequestId((current) => current + 1)}
        onWorkspaceModeChange={selectWorkspaceMode}
        updateRequestId={updateRequestId}
        version={appInfo.version}
        workspaceMode={workspaceMode}
        workspaceModeLocked={connected || busy}
      />

      <div className="workspace">
        <aside className="sidebar" aria-label={t("connection.sidebar")}>
          <div className="sidebar-heading">
            <h1>{t("connection.title")}</h1>
            <span>
              {workspaceMode === "terminal"
                ? t("terminal.protocol")
                : t("sftp.protocol")}
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
                label: t("common.terminal"),
                icon: <SquareTerminal size={14} />,
              },
              {
                value: "sftp",
                label: t("common.sftp"),
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
              <span className="field-label">{t("connection.host")}</span>
              <Input
                value={host}
                disabled={connected || busy}
                onChange={(event) => {
                  setHost(event.target.value);
                  resetHostTrust();
                }}
                placeholder={t("connection.hostPlaceholder")}
              />
            </label>

            <label className="field-group">
              <span className="field-label">{t("connection.port")}</span>
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
              {t("connection.probeFingerprint")}
            </Button>

            {hostKey && (
              <section
                className="fingerprint-panel"
                aria-label={t("connection.fingerprint")}
              >
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
                  {t("connection.trustFingerprint")}
                </Checkbox>
              </section>
            )}

            <label className="field-group">
              <span className="field-label">{t("connection.username")}</span>
              <Input
                value={username}
                autoComplete="username"
                disabled={connected || busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="field-group">
              <span className="field-label">{t("connection.password")}</span>
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
                {t("connection.connect")}
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
                {t("connection.disconnect")}
              </Button>
            )}
          </div>

          {errorMessage && (
            <Alert
              className="connection-error"
              type="error"
              showIcon
              message={
                connected
                  ? t("connection.errorConnected")
                  : t("connection.errorDisconnected")
              }
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
                <span>{t("common.terminal")}</span>
              </div>
              <span className="endpoint-label">
                {connected
                  ? `${username}@${host}:${port}`
                  : t("sftp.notConnected")}
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
                  <span>{connectionLabel(connectionState, t)}</span>
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
          {connectionLabel(connectionState, t)}
        </span>
        <span className="status-spacer" />
        <Tooltip
          title={
            workspaceMode === "terminal"
              ? t("terminal.type")
              : t("sftp.protocolVersion")
          }
        >
          <span>
            {workspaceMode === "terminal" ? "xterm-256color" : "SFTP v3"}
          </span>
        </Tooltip>
        <span className="status-divider" />
        <span>UTF-8</span>
      </footer>

      <Modal
        open={exitImpact !== null}
        title={t("exit.title")}
        closable={false}
        keyboard={!exitPending}
        maskClosable={false}
        afterOpenChange={(open) => {
          if (open) {
            exitCancelButtonRef.current?.focus();
          }
        }}
        footer={
          <>
            <Button
              ref={exitCancelButtonRef}
              disabled={exitPending}
              onClick={cancelAppExit}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="primary"
              danger
              loading={exitPending}
              onClick={() => void confirmAppExit()}
            >
              {t("exit.confirm")}
            </Button>
          </>
        }
        onCancel={cancelAppExit}
      >
        {exitImpact && <p>{exitImpactMessage(exitImpact, t, language)}</p>}
        {exitError && (
          <Alert
            type="error"
            showIcon
            message={t("exit.error")}
            description={exitError}
          />
        )}
      </Modal>
    </div>
  );
}

function exitImpactMessage(
  impact: ExitImpact,
  t: TFunction,
  language: string,
): string {
  const activity = [];
  if (impact.activeSessions > 0) {
    activity.push(t("exit.activeSessions", { count: impact.activeSessions }));
  }
  if (impact.activeTransfers > 0) {
    activity.push(t("exit.activeTransfers", { count: impact.activeTransfers }));
  }

  return t("exit.message", {
    activity: new Intl.ListFormat(language, {
      style: "long",
      type: "conjunction",
    }).format(activity),
  });
}

function connectionLabel(state: ConnectionState, t: TFunction): string {
  const labels: Record<ConnectionState, string> = {
    idle: t("status.idle"),
    probing: t("status.probing"),
    ready: t("status.ready"),
    connecting: t("status.connecting"),
    connected: t("status.connected"),
    closing: t("status.closing"),
    disconnected: t("status.disconnected"),
    failed: t("status.failed"),
  };

  return labels[state];
}

function errorText(error: unknown, fallback: string): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function isClosedSessionError(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.code === "session_not_found" || error.code === "session_closed")
  );
}

async function setWebviewMemoryUsage(low: boolean): Promise<void> {
  await ipc.setWebviewMemoryUsage(low).catch(() => undefined);
}
