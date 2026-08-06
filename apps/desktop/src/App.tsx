import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { Button, Checkbox, Input, InputNumber, Segmented, Tooltip } from "antd";
import {
  CircleX,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  FilePenLine,
  FileInput,
  Fingerprint,
  FolderPlus,
  FolderOpen,
  History,
  MoveDown,
  MoveUp,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  ScanSearch,
  Server,
  Settings,
  SquareTerminal,
  Star,
  Trash2,
  Unplug,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ConnectionEditorDialog,
  type ConnectionEditorIntent,
  type ConnectionEditorValue,
  type CredentialMode,
} from "./components/ConnectionEditorDialog";
import { ConnectionGroupDialog } from "./components/ConnectionGroupDialog";
import {
  ConnectionLaunchDialog,
  type ConnectionLaunchStep,
} from "./components/ConnectionLaunchDialog";
import { ConnectionWorkspaceEmptyState } from "./components/ConnectionWorkspaceEmptyState";
import { OpenSshImportDialog } from "./components/OpenSshImportDialog";
import { SessionTabBar, type SessionTab } from "./components/SessionTabBar";
import { SettingsView } from "./components/SettingsView";
import {
  TerminalPane,
  type TerminalHandle,
  type TerminalViewport,
} from "./components/TerminalPane";
import { shouldSkipApplicationShortcut } from "./components/terminalKeyboard";
import {
  parseExternalHttpLink,
  terminalPasteDetails,
  type ExternalHttpLink,
  type TerminalPasteDetails,
} from "./components/terminalSecurity";
import {
  AppDialog,
  EmptyState,
  FeedbackNotice,
  LoadingState,
} from "./components/Feedback";
import { SftpPane, type SftpTransferResult } from "./components/SftpPane";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { IpcError, ipc } from "./ipc/client";
import type {
  AppInfo,
  AppMenuAction,
  AuthMethod,
  ConnectionCatalog,
  ConnectionConfig,
  ConnectionDetails,
  ConnectionGroup,
  ConnectionListItem,
  ConnectionSettings,
  ExitImpact,
  HostKeyInfo,
  KeyboardInteractiveEvent,
  OpenSshImportPreview,
  OpenSshImportRequest,
  RemoteDirectoryListing,
  SshConnectionEvent,
  SshConnectionStage,
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
type ConnectionListMode = "connections" | "recent";

interface ConnectionTreeGroup {
  group: ConnectionGroup | null;
  connections: ConnectionListItem[];
}

type ConnectionSearchField = "name" | "host" | "username" | "group" | "notes";

interface ConnectionSearchResult {
  item: ConnectionListItem;
  matchedFields: ConnectionSearchField[];
}

interface PendingTerminalPaste extends TerminalPasteDetails {
  text: string;
}

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

const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  connectTimeoutSecs: 10,
  keepAliveSecs: 30,
};

const MEMORY_USAGE_RECOVERY_DELAY_MS = 60_000;
const EXIT_REQUESTED_EVENT = "app-exit-requested";
const APP_MENU_ACTION_EVENT = "app-menu-action";
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 420;
const SIDEBAR_WIDTH_DEFAULT = 228;
const SIDEBAR_WIDTH_STORAGE_KEY = "bx-ssh.sidebar-width";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "bx-ssh.sidebar-collapsed";

export function App() {
  const { t } = useTranslation();
  const { language } = useUiPreferences();
  const [appInfo, setAppInfo] = useState(fallbackInfo);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionSettings, setConnectionSettings] =
    useState<ConnectionSettings>(DEFAULT_CONNECTION_SETTINGS);
  const [hostKey, setHostKey] = useState<HostKeyInfo | null>(null);
  const [hostFingerprintKnown, setHostFingerprintKnown] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [fingerprintTrustPending, setFingerprintTrustPending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [connectionStage, setConnectionStage] =
    useState<SshConnectionStage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [terminalSelection, setTerminalSelection] = useState("");
  const [terminalClipboardPending, setTerminalClipboardPending] =
    useState(false);
  const [terminalInteractionError, setTerminalInteractionError] = useState<
    string | null
  >(null);
  const [pendingTerminalPaste, setPendingTerminalPaste] =
    useState<PendingTerminalPaste | null>(null);
  const [externalTerminalLink, setExternalTerminalLink] =
    useState<ExternalHttpLink | null>(null);
  const [externalLinkPending, setExternalLinkPending] = useState(false);
  const [externalLinkError, setExternalLinkError] = useState<string | null>(
    null,
  );
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("terminal");
  const [connectionListMode, setConnectionListMode] =
    useState<ConnectionListMode>("connections");
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(readSidebarCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sftpSessionId, setSftpSessionId] = useState<string | null>(null);
  const [sftpDirectory, setSftpDirectory] =
    useState<RemoteDirectoryListing | null>(null);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpTransferActive, setSftpTransferActive] = useState(false);
  const [sftpTransferResult, setSftpTransferResult] =
    useState<SftpTransferResult | null>(null);
  const [sessionCloseOpen, setSessionCloseOpen] = useState(false);
  const [sessionClosePending, setSessionClosePending] = useState(false);
  const [sessionCloseError, setSessionCloseError] = useState<string | null>(
    null,
  );
  const [exitImpact, setExitImpact] = useState<ExitImpact | null>(null);
  const [exitPending, setExitPending] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const [updateRequestId, setUpdateRequestId] = useState(0);
  const [connectionCatalog, setConnectionCatalog] = useState<ConnectionCatalog>(
    { groups: [], connections: [] },
  );
  const [connectionCatalogLoading, setConnectionCatalogLoading] =
    useState(true);
  const [connectionCatalogError, setConnectionCatalogError] = useState<
    string | null
  >(null);
  const [connectionCatalogNotice, setConnectionCatalogNotice] = useState<
    string | null
  >(null);
  const [connectionSearch, setConnectionSearch] = useState("");
  const [connectionActionId, setConnectionActionId] = useState<string | null>(
    null,
  );
  const [catalogMutationKey, setCatalogMutationKey] = useState<string | null>(
    null,
  );
  const [connectionGroupDialogOpen, setConnectionGroupDialogOpen] =
    useState(false);
  const [connectionGroupInitialValue, setConnectionGroupInitialValue] =
    useState<ConnectionGroup>();
  const [connectionGroupPending, setConnectionGroupPending] = useState(false);
  const [connectionGroupError, setConnectionGroupError] = useState<
    string | null
  >(null);
  const [deleteGroupTarget, setDeleteGroupTarget] =
    useState<ConnectionGroup | null>(null);
  const [deleteGroupPending, setDeleteGroupPending] = useState(false);
  const [deleteGroupError, setDeleteGroupError] = useState<string | null>(null);
  const [loadedConnectionId, setLoadedConnectionId] = useState<string | null>(
    null,
  );
  const [activeSessionTab, setActiveSessionTab] = useState<SessionTab | null>(
    null,
  );
  const [connectionLaunchStep, setConnectionLaunchStep] =
    useState<ConnectionLaunchStep>();
  const [keyboardInteractivePrompt, setKeyboardInteractivePrompt] = useState<
    Extract<KeyboardInteractiveEvent, { type: "prompt" }> | undefined
  >();
  const [
    keyboardInteractiveResponsePending,
    setKeyboardInteractiveResponsePending,
  ] = useState(false);
  const [launchCredentialRef, setLaunchCredentialRef] = useState<string | null>(
    null,
  );
  const [launchCredentialPassword, setLaunchCredentialPassword] = useState<
    string | undefined
  >();
  const [launchCredentialMode, setLaunchCredentialMode] =
    useState<CredentialMode>("ask");
  const [launchAuthMethod, setLaunchAuthMethod] =
    useState<AuthMethod>("password");
  const [launchKeyReferenceId, setLaunchKeyReferenceId] = useState<
    string | null
  >(null);
  const [connectionEditorInitialValue, setConnectionEditorInitialValue] =
    useState<ConnectionEditorValue>();
  const [connectionEditorOpen, setConnectionEditorOpen] = useState(false);
  const [connectionEditorPending, setConnectionEditorPending] = useState(false);
  const [connectionEditorError, setConnectionEditorError] = useState<
    string | null
  >(null);
  const [connectionEditorNotice, setConnectionEditorNotice] = useState<
    string | undefined
  >();
  const [openSshImportOpen, setOpenSshImportOpen] = useState(false);
  const [openSshImportPreview, setOpenSshImportPreview] =
    useState<OpenSshImportPreview>();
  const [openSshImportLoading, setOpenSshImportLoading] = useState(false);
  const [openSshImportPending, setOpenSshImportPending] = useState(false);
  const [openSshImportError, setOpenSshImportError] = useState<string | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ConnectionListItem | null>(
    null,
  );
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const terminalClipboardPendingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const loadedConnectionIdRef = useRef<string | null>(null);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const sftpSessionIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resizeTimerRef = useRef<number | null>(null);
  const memoryUsageTimerRef = useRef<number | null>(null);
  const connectionAttemptRef = useRef(0);
  const activeConnectionAttemptIdRef = useRef<string | null>(null);
  const connectionFlowPendingRef = useRef(false);
  const sessionTabSequenceRef = useRef(0);
  const sftpOperationGenerationRef = useRef(0);
  const sessionCloseCancelButtonRef = useRef<HTMLButtonElement>(null);
  const terminalPasteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const externalLinkCancelButtonRef = useRef<HTMLButtonElement>(null);
  const exitCancelButtonRef = useRef<HTMLButtonElement>(null);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const hostKeyRef = useRef<HostKeyInfo | null>(null);
  const localizedErrorText = useCallback(
    (error: unknown) => errorText(error, t),
    [t],
  );

  const loadConnectionCatalog = useCallback(async () => {
    setConnectionCatalogLoading(true);
    setConnectionCatalogError(null);
    try {
      const catalog = await ipc.listConnections();
      setConnectionCatalog(catalog ?? { groups: [], connections: [] });
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setConnectionCatalogLoading(false);
    }
  }, [localizedErrorText]);

  const connectionTree = useMemo(
    () => buildConnectionTree(connectionCatalog),
    [connectionCatalog],
  );
  const connectionSearchResults = useMemo(
    () => searchConnections(connectionCatalog, connectionSearch),
    [connectionCatalog, connectionSearch],
  );
  const allRecentConnections = useMemo(
    () => getRecentConnections(connectionCatalog.connections),
    [connectionCatalog.connections],
  );
  const recentConnections = useMemo(
    () => allRecentConnections.slice(0, 3),
    [allRecentConnections],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(sidebarWidth),
      );
    } catch {
      // The width remains active for the current process when storage is denied.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(sidebarCollapsed),
      );
    } catch {
      // The collapsed state remains active when storage is unavailable.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!sidebarResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const resize = sidebarResizeRef.current;
      if (!resize) return;
      setSidebarWidth(
        clampSidebarWidth(resize.startWidth + event.clientX - resize.startX),
      );
    };
    const stopResizing = () => {
      sidebarResizeRef.current = null;
      setSidebarResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [sidebarResizing]);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    setSidebarResizing(true);
  };

  const resizeSidebarByKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth - 16;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth + 16;
    if (event.key === "Home") nextWidth = SIDEBAR_WIDTH_MIN;
    if (event.key === "End") nextWidth = SIDEBAR_WIDTH_MAX;
    if (nextWidth === null) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(nextWidth));
  };

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
      connectionFlowPendingRef.current ||
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
    let active = true;

    void ipc
      .listConnections()
      .then((catalog) => {
        if (active) {
          setConnectionCatalog(catalog ?? { groups: [], connections: [] });
          setConnectionCatalogError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setConnectionCatalogError(localizedErrorText(error));
        }
      })
      .finally(() => {
        if (active) {
          setConnectionCatalogLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [localizedErrorText]);

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
      if (shouldSkipApplicationShortcut(event)) return;
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
    loadedConnectionIdRef.current = loadedConnectionId;
  }, [loadedConnectionId]);

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
      const activeAttemptId = activeConnectionAttemptIdRef.current;
      if (activeAttemptId) {
        void ipc.cancelSshConnection(activeAttemptId);
      }
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
    setHostFingerprintKnown(false);
    setTrusted(false);
    setFingerprintTrustPending(false);
    setErrorMessage(null);
    setConnectionState("idle");
    setConnectionStage(null);
  }, []);

  const probeHost = async (
    targetHost = host,
    targetPort = port,
    settings = connectionSettings,
  ): Promise<{ hostKey: HostKeyInfo; known: boolean } | null> => {
    setConnectionState("probing");
    setErrorMessage(null);
    setHostKey(null);
    setHostFingerprintKnown(false);
    setTrusted(false);
    setFingerprintTrustPending(false);

    try {
      const hostKey = await ipc.probeSshHost({
        host: targetHost,
        port: targetPort,
        settings,
      });
      const knownHost = await ipc.getKnownHost(targetHost, targetPort);
      const known =
        knownHost?.algorithm === hostKey.algorithm &&
        knownHost.fingerprintSha256 === hostKey.fingerprintSha256;
      setHostKey(hostKey);
      setHostFingerprintKnown(known);
      setTrusted(known);
      setConnectionState("ready");
      return { hostKey, known };
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
      setConnectionState("failed");
      return null;
    }
  };

  const openNewConnectionEditor = () => {
    setConnectionEditorInitialValue(undefined);
    setConnectionEditorError(null);
    setConnectionEditorNotice(undefined);
    setConnectionEditorOpen(true);
  };

  const connectionLaunchBlocked = () =>
    connectionFlowPendingRef.current ||
    ["probing", "connecting", "connected", "closing"].includes(
      connectionStateRef.current,
    ) ||
    sessionIdRef.current !== null ||
    sftpSessionIdRef.current !== null;

  const beginConnectionFlow = async (
    config: ConnectionConfig,
    settings: ConnectionSettings,
  ) => {
    if (connectionLaunchBlocked()) {
      return;
    }

    const request = ++connectionAttemptRef.current;
    connectionFlowPendingRef.current = true;
    const tab: SessionTab = {
      clientId: `session-tab-${++sessionTabSequenceRef.current}`,
      connectionId: config.id,
      endpoint: `${config.username}@${config.host}:${config.port}`,
      name: config.name,
    };
    setActiveSessionTab(tab);
    setWorkspaceMode("terminal");
    setHost(config.host);
    setPort(config.port);
    setUsername(config.username);
    setConnectionSettings(settings);
    setPassword("");
    setLaunchAuthMethod(config.authMethod);
    setLaunchKeyReferenceId(config.keyReferenceId);
    setLaunchCredentialRef(config.credentialRef);
    setLaunchCredentialMode(config.credentialRef ? "vault" : "ask");
    setLaunchCredentialPassword(undefined);
    setKeyboardInteractivePrompt(undefined);
    setKeyboardInteractiveResponsePending(false);
    setLoadedConnectionId(config.id);
    loadedConnectionIdRef.current = config.id;
    resetHostTrust();

    const result = await probeHost(config.host, config.port, settings);
    if (connectionAttemptRef.current === request && result) {
      if (config.authMethod === "password" && config.credentialRef) {
        try {
          setLaunchCredentialPassword(
            (await ipc.getPasswordCredential(config.credentialRef)) ??
              undefined,
          );
        } catch (error) {
          if (connectionAttemptRef.current === request) {
            setErrorMessage(localizedErrorText(error));
          }
        }
      }
      if (connectionAttemptRef.current !== request) {
        connectionFlowPendingRef.current = false;
        return;
      }
      setConnectionLaunchStep(
        result.known
          ? config.authMethod === "keyboardInteractive"
            ? "keyboardInteractive"
            : "password"
          : "fingerprint",
      );
    } else {
      connectionFlowPendingRef.current = false;
    }
  };

  const loadOpenSshImportPreview = async (path: string | null) => {
    setOpenSshImportLoading(true);
    setOpenSshImportError(null);
    try {
      const preview = await ipc.previewOpenSshConfig(path);
      setOpenSshImportPreview(preview);
    } catch (error) {
      setOpenSshImportPreview(undefined);
      setOpenSshImportError(localizedErrorText(error));
    } finally {
      setOpenSshImportLoading(false);
    }
  };

  const openOpenSshImport = () => {
    setOpenSshImportOpen(true);
    setOpenSshImportPreview(undefined);
    setOpenSshImportError(null);
    void loadOpenSshImportPreview(null);
  };

  const browseOpenSshConfig = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("connectionImport.chooseFileTitle"),
        filters: [
          {
            name: t("connectionImport.openSshConfig"),
            extensions: ["config", "conf", "txt"],
          },
        ],
      });
      if (typeof selected === "string") {
        await loadOpenSshImportPreview(selected);
      }
    } catch (error) {
      setOpenSshImportError(localizedErrorText(error));
    }
  };

  const importOpenSshConnections = async (request: OpenSshImportRequest) => {
    setOpenSshImportPending(true);
    setOpenSshImportError(null);
    try {
      const result = await ipc.importOpenSshConnections(request);
      await loadConnectionCatalog();
      setConnectionCatalogNotice(
        t("connectionImport.completed", {
          imported: result.imported,
          overwritten: result.overwritten,
          skipped: result.skipped,
        }),
      );
      setOpenSshImportOpen(false);
      setOpenSshImportPreview(undefined);
    } catch (error) {
      setOpenSshImportError(localizedErrorText(error));
    } finally {
      setOpenSshImportPending(false);
    }
  };

  const openNewConnectionGroup = () => {
    setConnectionGroupInitialValue(undefined);
    setConnectionGroupError(null);
    setConnectionGroupDialogOpen(true);
  };

  const openConnectionGroupEditor = (group: ConnectionGroup) => {
    setConnectionGroupInitialValue(group);
    setConnectionGroupError(null);
    setConnectionGroupDialogOpen(true);
  };

  const saveConnectionGroup = async (group: ConnectionGroup) => {
    setConnectionGroupPending(true);
    setConnectionGroupError(null);
    try {
      const isNew = !connectionCatalog.groups.some(
        (existing) => existing.id === group.id,
      );
      await ipc.saveConnectionGroup({
        ...group,
        sortOrder: isNew ? connectionCatalog.groups.length : group.sortOrder,
      });
      await loadConnectionCatalog();
      setConnectionCatalogNotice(
        t("connectionGroup.saved", { name: group.name }),
      );
      setConnectionGroupDialogOpen(false);
    } catch (error) {
      setConnectionGroupError(localizedErrorText(error));
    } finally {
      setConnectionGroupPending(false);
    }
  };

  const toggleConnectionGroup = async (group: ConnectionGroup) => {
    const key = `group-collapse:${group.id}`;
    setCatalogMutationKey(key);
    setConnectionCatalogError(null);
    try {
      await ipc.setConnectionGroupCollapsed(group.id, !group.isCollapsed);
      await loadConnectionCatalog();
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setCatalogMutationKey(null);
    }
  };

  const toggleFavoriteConnection = async (item: ConnectionListItem) => {
    const key = `favorite:${item.config.id}`;
    setCatalogMutationKey(key);
    setConnectionCatalogError(null);
    try {
      await ipc.setConnectionFavorite(item.config.id, !item.isFavorite);
      await loadConnectionCatalog();
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setCatalogMutationKey(null);
    }
  };

  const moveConnectionGroup = async (groupId: string, direction: -1 | 1) => {
    const ids = connectionTree.flatMap(({ group }) =>
      group ? [group.id] : [],
    );
    if (!moveId(ids, groupId, direction)) return;
    setCatalogMutationKey(`group-order:${groupId}`);
    setConnectionCatalogError(null);
    try {
      await ipc.reorderConnectionGroups(ids);
      await loadConnectionCatalog();
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setCatalogMutationKey(null);
    }
  };

  const moveConnection = async (
    item: ConnectionListItem,
    siblings: ConnectionListItem[],
    direction: -1 | 1,
  ) => {
    const favoriteSiblings = siblings.filter(
      (sibling) => sibling.isFavorite === item.isFavorite,
    );
    const ids = favoriteSiblings.map((sibling) => sibling.config.id);
    if (!moveId(ids, item.config.id, direction)) return;
    const reordered = siblings.map((sibling) => sibling.config.id);
    const movingIndexes = reordered
      .map((id, index) => (ids.includes(id) ? index : -1))
      .filter((index) => index >= 0);
    movingIndexes.forEach((index, offset) => {
      reordered[index] = ids[offset];
    });
    setCatalogMutationKey(`connection-order:${item.config.id}`);
    setConnectionCatalogError(null);
    try {
      await ipc.reorderConnections(item.config.groupId, reordered);
      await loadConnectionCatalog();
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setCatalogMutationKey(null);
    }
  };

  const confirmDeleteConnectionGroup = async () => {
    if (!deleteGroupTarget) return;
    setDeleteGroupPending(true);
    setDeleteGroupError(null);
    try {
      await ipc.deleteConnectionGroup(deleteGroupTarget.id);
      await loadConnectionCatalog();
      setConnectionCatalogNotice(
        t("connectionGroup.deleted", { name: deleteGroupTarget.name }),
      );
      setDeleteGroupTarget(null);
    } catch (error) {
      setDeleteGroupError(localizedErrorText(error));
    } finally {
      setDeleteGroupPending(false);
    }
  };

  const openSavedConnectionEditor = async (
    item: ConnectionListItem,
    duplicate: boolean,
  ) => {
    setConnectionActionId(item.config.id);
    setConnectionCatalogError(null);
    setConnectionCatalogNotice(null);
    try {
      const details = await ipc.getConnection(item.config.id);
      if (!details) {
        throw new Error(t("connectionCatalog.notFound"));
      }
      setConnectionEditorInitialValue(
        duplicate
          ? duplicateConnection(details, t)
          : connectionDetailsToEditorValue(details),
      );
      setConnectionEditorError(null);
      setConnectionEditorNotice(
        !duplicate &&
          loadedConnectionId === item.config.id &&
          (connected || sessionId !== null || sftpSessionId !== null)
          ? t("connectionCatalog.editActiveNotice")
          : undefined,
      );
      setConnectionEditorOpen(true);
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setConnectionActionId(null);
    }
  };

  const loadSavedConnection = async (item: ConnectionListItem) => {
    if (connectionLaunchBlocked()) return;
    setConnectionActionId(item.config.id);
    setConnectionCatalogError(null);
    setConnectionCatalogNotice(null);
    try {
      const details = await ipc.getConnection(item.config.id);
      if (!details) {
        throw new Error(t("connectionCatalog.notFound"));
      }
      await beginConnectionFlow(
        details.connection.config,
        details.settings.resolved,
      );
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setConnectionActionId(null);
    }
  };

  const reconnectSession = async () => {
    if (
      connectionState !== "disconnected" ||
      !activeSessionTab ||
      connectionFlowPendingRef.current
    ) {
      return;
    }

    const connectionId =
      loadedConnectionIdRef.current ?? activeSessionTab.connectionId;
    const saved = connectionId
      ? connectionCatalog.connections.find(
          (item) => item.config.id === connectionId,
        )
      : undefined;
    if (saved) {
      await loadSavedConnection(saved);
      return;
    }

    // Unsaved direct connections retain only the endpoint and host trust.
    // Authentication is deliberately requested again after a disconnect.
    setConnectionState(hostKey ? "ready" : "idle");
    setConnectionLaunchStep(
      launchAuthMethod === "keyboardInteractive"
        ? "keyboardInteractive"
        : "password",
    );
  };

  const recordLoadedConnectionSuccess = async () => {
    const id = loadedConnectionIdRef.current;
    if (!id) return;
    try {
      await ipc.recordSuccessfulConnection(id);
      await loadConnectionCatalog();
    } catch {
      // A successful SSH/SFTP session must not be changed into a failed state
      // when only the local recent-connection summary cannot be updated.
    }
  };

  const saveConnection = async (
    value: ConnectionEditorValue,
    intent: ConnectionEditorIntent,
  ) => {
    setConnectionEditorPending(true);
    setConnectionEditorError(null);
    try {
      await ipc.saveConnection(value.config, value.settings);
      if (
        intent === "save" &&
        value.credentialMode === "vault" &&
        value.password &&
        value.config.credentialRef
      ) {
        await ipc.savePasswordCredential(
          value.config.credentialRef,
          value.password,
        );
      }
      const connectionToLaunch =
        intent === "saveAndConnect"
          ? await ipc.getConnection(value.config.id)
          : undefined;
      if (intent === "saveAndConnect" && !connectionToLaunch) {
        throw new Error(t("connectionCatalog.notFound"));
      }
      await loadConnectionCatalog();
      setConnectionCatalogNotice(
        t("connectionCatalog.saved", {
          name: value.config.name,
        }),
      );
      setConnectionEditorOpen(false);

      if (intent === "saveAndConnect") {
        await beginConnectionFlow(
          connectionToLaunch!.connection.config,
          connectionToLaunch!.settings.resolved,
        );
      }
    } catch (error) {
      setConnectionEditorError(localizedErrorText(error));
    } finally {
      setConnectionEditorPending(false);
    }
  };

  const confirmDeleteConnection = async () => {
    if (!deleteTarget) {
      return;
    }
    setDeletePending(true);
    setDeleteError(null);
    try {
      await ipc.deleteConnection(deleteTarget.config.id);
      await loadConnectionCatalog();
      setConnectionCatalogNotice(
        t("connectionCatalog.deleted", { name: deleteTarget.config.name }),
      );
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(localizedErrorText(error));
    } finally {
      setDeletePending(false);
    }
  };

  const beginSshConnectionAttempt = () => {
    const attemptId = createConnectionAttemptId();
    activeConnectionAttemptIdRef.current = attemptId;
    setConnectionStage("created");
    return attemptId;
  };

  const handleSshConnectionEvent = (
    attemptId: string,
    event: SshConnectionEvent,
  ) => {
    if (
      activeConnectionAttemptIdRef.current !== attemptId ||
      event.attemptId !== attemptId
    ) {
      return;
    }
    setConnectionStage(event.stage);
  };

  const requestConnectionCancellation = () => {
    const attemptId = activeConnectionAttemptIdRef.current;
    activeConnectionAttemptIdRef.current = null;
    if (attemptId) {
      void ipc.cancelSshConnection(attemptId).catch(() => undefined);
    }
  };

  const cancelDirectConnection = () => {
    connectionAttemptRef.current += 1;
    requestConnectionCancellation();
    setPassword("");
    setErrorMessage(null);
    setConnectionStage(null);
    setConnectionState(hostKeyRef.current ? "ready" : "idle");
  };

  const connectTerminal = async (
    credentialOverride?: string,
  ): Promise<boolean> => {
    const credential = credentialOverride ?? password;
    const privateKeyAuth = launchAuthMethod === "privateKey";
    const keyboardInteractiveAuth = launchAuthMethod === "keyboardInteractive";
    if (
      !hostKey ||
      !trusted ||
      !username ||
      (privateKeyAuth
        ? !launchKeyReferenceId
        : keyboardInteractiveAuth
          ? false
          : !credential)
    ) {
      return false;
    }

    if (!(await ensureHostFingerprintTrusted())) {
      return false;
    }

    setConnectionState("connecting");
    setErrorMessage(null);
    setKeyboardInteractivePrompt(undefined);
    setKeyboardInteractiveResponsePending(false);
    terminalRef.current?.reset();

    const attempt = ++connectionAttemptRef.current;
    const connectionAttemptId = beginSshConnectionAttempt();
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
      sessionIdRef.current = null;
      setSessionId(null);
      setSessionCloseOpen(false);
      setSessionCloseError(null);
      if (event.type === "error") {
        setErrorMessage(commandErrorText(event.code, event.message, t));
        setConnectionState("disconnected");
        return;
      }

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

    const handleKeyboardInteractiveEvent = (
      event: KeyboardInteractiveEvent,
    ) => {
      if (
        connectionAttemptRef.current !== attempt ||
        event.type !== "prompt" ||
        event.attemptId !== connectionAttemptId
      ) {
        return;
      }
      setKeyboardInteractiveResponsePending(false);
      setKeyboardInteractivePrompt(event);
    };

    const viewport = terminalRef.current?.viewport() ?? fallbackViewport;

    try {
      await enableLowMemoryUsage();
      const channels = {
        onAuth: handleKeyboardInteractiveEvent,
        onState: (event: SshConnectionEvent) =>
          handleSshConnectionEvent(connectionAttemptId, event),
        onEvent: handleTerminalEvent,
        onOutput: handleTerminalOutput,
      };
      const response = privateKeyAuth
        ? await ipc.startPrivateKeyShell(
            {
              attemptId: connectionAttemptId,
              host,
              port,
              username,
              keyReferenceId: launchKeyReferenceId as string,
              passphrase: credential || null,
              expectedFingerprint: hostKey.fingerprintSha256,
              settings: connectionSettings,
              ...viewport,
            },
            channels,
          )
        : keyboardInteractiveAuth
          ? await ipc.startKeyboardInteractiveShell(
              {
                attemptId: connectionAttemptId,
                host,
                port,
                username,
                expectedFingerprint: hostKey.fingerprintSha256,
                settings: connectionSettings,
                ...viewport,
              },
              channels,
            )
          : await ipc.startPasswordShell(
              {
                attemptId: connectionAttemptId,
                host,
                port,
                username,
                password: credential,
                expectedFingerprint: hostKey.fingerprintSha256,
                settings: connectionSettings,
                ...viewport,
              },
              channels,
            );
      acknowledgementSessionId = response.sessionId;
      queueAcknowledgement(processedSequence);

      if (connectionAttemptRef.current !== attempt) {
        void ipc
          .closeTerminalSession(response.sessionId)
          .catch(() => undefined);
        return false;
      }

      setPassword("");
      setKeyboardInteractivePrompt(undefined);
      setKeyboardInteractiveResponsePending(false);
      if (ended) {
        void ipc
          .closeTerminalSession(response.sessionId)
          .catch(() => undefined);
        return false;
      }

      sessionIdRef.current = response.sessionId;
      scheduleNormalMemoryUsage();
      setSessionId(response.sessionId);
      setHostKey(response.hostKey);
      setConnectionState("connected");
      void recordLoadedConnectionSuccess();
      terminalRef.current?.focus();
      return true;
    } catch (error) {
      if (connectionAttemptRef.current !== attempt) {
        return false;
      }
      setPassword("");
      setKeyboardInteractivePrompt(undefined);
      setKeyboardInteractiveResponsePending(false);
      setErrorMessage(localizedErrorText(error));
      setConnectionState("failed");
      return false;
    } finally {
      if (activeConnectionAttemptIdRef.current === connectionAttemptId) {
        activeConnectionAttemptIdRef.current = null;
      }
    }
  };

  const connectSftp = async () => {
    const privateKeyAuth = launchAuthMethod === "privateKey";
    const credential = password;
    if (
      !hostKey ||
      !trusted ||
      !username ||
      (privateKeyAuth ? !launchKeyReferenceId : !credential)
    ) {
      return;
    }

    if (!(await ensureHostFingerprintTrusted())) {
      return;
    }

    setConnectionState("connecting");
    setErrorMessage(null);
    setSftpTransferResult(null);
    terminalRef.current?.reset();
    const attempt = ++connectionAttemptRef.current;
    const connectionAttemptId = beginSshConnectionAttempt();

    try {
      await enableLowMemoryUsage();
      const response = privateKeyAuth
        ? await ipc.startPrivateKeySftp(
            {
              attemptId: connectionAttemptId,
              host,
              port,
              username,
              keyReferenceId: launchKeyReferenceId as string,
              passphrase: credential || null,
              expectedFingerprint: hostKey.fingerprintSha256,
              settings: connectionSettings,
              initialPath: ".",
            },
            (event) => handleSshConnectionEvent(connectionAttemptId, event),
          )
        : await ipc.startPasswordSftp(
            {
              attemptId: connectionAttemptId,
              host,
              port,
              username,
              password: credential,
              expectedFingerprint: hostKey.fingerprintSha256,
              settings: connectionSettings,
              initialPath: ".",
            },
            (event) => handleSshConnectionEvent(connectionAttemptId, event),
          );
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
      void recordLoadedConnectionSuccess();
    } catch (error) {
      if (connectionAttemptRef.current !== attempt) {
        return;
      }
      setPassword("");
      setErrorMessage(localizedErrorText(error));
      setConnectionState("failed");
    } finally {
      if (activeConnectionAttemptIdRef.current === connectionAttemptId) {
        activeConnectionAttemptIdRef.current = null;
      }
    }
  };

  const connectCurrentMode = async () => {
    if (workspaceMode === "terminal") {
      await connectTerminal();
    } else {
      await connectSftp();
    }
  };

  const persistHostFingerprint = async (): Promise<boolean> => {
    if (!hostKey) {
      return false;
    }
    if (hostFingerprintKnown) {
      return true;
    }

    await ipc.trustHostFingerprint({
      host,
      port,
      hostKey,
    });
    setHostFingerprintKnown(true);
    setTrusted(true);
    return true;
  };

  const ensureHostFingerprintTrusted = async (): Promise<boolean> => {
    try {
      return await persistHostFingerprint();
    } catch (error) {
      setErrorMessage(localizedErrorText(error));
      setConnectionState("failed");
      return false;
    }
  };

  const confirmConnectionFingerprint = () => {
    if (!hostKey || fingerprintTrustPending) {
      return;
    }
    setFingerprintTrustPending(true);
    void persistHostFingerprint()
      .then(() => {
        setConnectionLaunchStep(
          launchAuthMethod === "keyboardInteractive"
            ? "keyboardInteractive"
            : "password",
        );
      })
      .catch((error: unknown) => {
        setErrorMessage(localizedErrorText(error));
        setConnectionState("failed");
      })
      .finally(() => setFingerprintTrustPending(false));
  };

  const cancelConnectionFlow = () => {
    connectionAttemptRef.current += 1;
    requestConnectionCancellation();
    connectionFlowPendingRef.current = false;
    setConnectionLaunchStep(undefined);
    setLaunchCredentialRef(null);
    setLaunchCredentialMode("ask");
    setLaunchAuthMethod("password");
    setLaunchKeyReferenceId(null);
    setLaunchCredentialPassword(undefined);
    setKeyboardInteractivePrompt(undefined);
    setKeyboardInteractiveResponsePending(false);
    setPassword("");
    setTrusted(false);
    setHostFingerprintKnown(false);
    setFingerprintTrustPending(false);
    setHostKey(null);
    setConnectionState("idle");
    setConnectionStage(null);
    setActiveSessionTab(null);
    setLoadedConnectionId(null);
    loadedConnectionIdRef.current = null;
    setConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
  };

  const saveAuthenticatedCredential = async (
    credential: string,
    mode: CredentialMode,
  ) => {
    if (mode !== "vault") {
      return;
    }
    const connectionId = loadedConnectionIdRef.current;
    const credentialRef =
      launchCredentialRef ?? (connectionId ? `password:${connectionId}` : null);
    if (!credentialRef) {
      throw new Error(t("connectionAuthentication.credentialReferenceMissing"));
    }
    await ipc.savePasswordCredential(credentialRef, credential);
    if (connectionId && !launchCredentialRef) {
      const details = await ipc.getConnection(connectionId);
      if (details && !details.connection.config.credentialRef) {
        await ipc.saveConnection(
          { ...details.connection.config, credentialRef },
          details.settings.layers.connection ?? {
            connectTimeoutSecs: null,
            keepAliveSecs: null,
          },
        );
        await loadConnectionCatalog();
      }
      setLaunchCredentialRef(credentialRef);
    }
  };

  const authenticatePendingConnection = async (
    credential: string,
    mode: CredentialMode,
  ) => {
    connectionFlowPendingRef.current = true;
    const connectedSuccessfully = await connectTerminal(credential);
    if (connectedSuccessfully) {
      try {
        if (launchAuthMethod === "password") {
          await saveAuthenticatedCredential(credential, mode);
        }
      } catch (error) {
        setErrorMessage(localizedErrorText(error));
      }
      connectionFlowPendingRef.current = false;
      setConnectionLaunchStep(undefined);
      setLaunchCredentialPassword(undefined);
    } else {
      connectionFlowPendingRef.current = false;
    }
  };

  const submitKeyboardInteractive = (responses: string[]) => {
    const attemptId = activeConnectionAttemptIdRef.current;
    if (!attemptId || keyboardInteractiveResponsePending) {
      return;
    }
    setKeyboardInteractiveResponsePending(true);
    void ipc.respondKeyboardInteractive(attemptId, responses).catch((error) => {
      if (activeConnectionAttemptIdRef.current === attemptId) {
        setKeyboardInteractiveResponsePending(false);
        setErrorMessage(localizedErrorText(error));
      }
    });
  };

  const resetSessionWorkspace = () => {
    connectionAttemptRef.current += 1;
    connectionFlowPendingRef.current = false;
    sftpOperationGenerationRef.current += 1;
    setConnectionLaunchStep(undefined);
    setLaunchCredentialPassword(undefined);
    setKeyboardInteractivePrompt(undefined);
    setKeyboardInteractiveResponsePending(false);
    setPendingTerminalPaste(null);
    setExternalTerminalLink(null);
    setExternalLinkError(null);
    setTerminalInteractionError(null);
    setTerminalSelection("");
    setConnectionState("idle");
    setConnectionStage(null);
    sessionIdRef.current = null;
    setSessionId(null);
    sftpSessionIdRef.current = null;
    setSftpSessionId(null);
    setSftpDirectory(null);
    setSftpBusy(false);
    setSftpTransferActive(false);
    setSftpTransferResult(null);
    setSessionCloseOpen(false);
    setSessionClosePending(false);
    setSessionCloseError(null);
    setActiveSessionTab(null);
    setLoadedConnectionId(null);
    loadedConnectionIdRef.current = null;
    setHostKey(null);
    setTrusted(false);
    setPassword("");
    terminalRef.current?.reset();
  };

  const requestSessionClose = () => {
    const impact = {
      activeSessions:
        Number(sessionId !== null) + Number(sftpSessionId !== null),
      activeTransfers: Number(sftpTransferActive),
    };

    if (!impact.activeSessions && !impact.activeTransfers) {
      resetSessionWorkspace();
      return;
    }

    setSessionCloseError(null);
    setSessionCloseOpen(true);
  };

  const confirmSessionClose = async () => {
    const terminalSessionId = sessionId ?? sessionIdRef.current;
    const fileSessionId = sftpSessionId ?? sftpSessionIdRef.current;
    const connectionAttempt = connectionAttemptRef.current;
    const sftpOperationGeneration = sftpOperationGenerationRef.current;
    setSessionClosePending(true);
    setSessionCloseError(null);
    setConnectionState("closing");
    connectionAttemptRef.current += 1;
    sftpOperationGenerationRef.current += 1;

    const failures: unknown[] = [];
    if (terminalSessionId) {
      try {
        await ipc.closeTerminalSession(terminalSessionId);
        sessionIdRef.current = null;
        setSessionId(null);
      } catch (error) {
        if (isClosedSessionError(error)) {
          sessionIdRef.current = null;
          setSessionId(null);
        } else {
          failures.push(error);
        }
      }
    }

    if (fileSessionId) {
      try {
        await ipc.closeSftpSession(fileSessionId);
        sftpSessionIdRef.current = null;
        setSftpSessionId(null);
      } catch (error) {
        if (isClosedSessionError(error)) {
          sftpSessionIdRef.current = null;
          setSftpSessionId(null);
        } else {
          failures.push(error);
        }
      }
    }

    if (failures.length > 0) {
      connectionAttemptRef.current = connectionAttempt;
      sftpOperationGenerationRef.current = sftpOperationGeneration;
      setSessionClosePending(false);
      setSessionCloseError(localizedErrorText(failures[0]));
      setConnectionState(
        sessionIdRef.current || sftpSessionIdRef.current
          ? "connected"
          : "disconnected",
      );
      return;
    }

    setSessionClosePending(false);
    setSessionCloseOpen(false);
    setSessionCloseError(null);
    resetSessionWorkspace();
    void enableLowMemoryUsage();
  };

  const cancelSessionClose = () => {
    if (sessionClosePending) {
      return;
    }
    setSessionCloseOpen(false);
    setSessionCloseError(null);
  };

  const navigateSftp = async (path: string) => {
    const activeSessionId = sftpSessionIdRef.current;
    if (!activeSessionId) {
      return;
    }
    const operationGeneration = sftpOperationGenerationRef.current;

    setSftpBusy(true);
    setErrorMessage(null);
    try {
      const directory = await ipc.listSftpDirectory(activeSessionId, path);
      if (
        operationGeneration !== sftpOperationGenerationRef.current ||
        sftpSessionIdRef.current !== activeSessionId
      ) {
        return;
      }
      setSftpDirectory(directory);
    } catch (error) {
      if (operationGeneration === sftpOperationGenerationRef.current) {
        setErrorMessage(localizedErrorText(error));
      }
    } finally {
      if (operationGeneration === sftpOperationGenerationRef.current) {
        setSftpBusy(false);
      }
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
    const operationGeneration = sftpOperationGenerationRef.current;

    setSftpBusy(true);
    setSftpTransferActive(true);
    setErrorMessage(null);
    setSftpTransferResult(null);
    try {
      const summary = await ipc.uploadSftpFile(
        activeSessionId,
        localPath,
        remotePath,
        language,
      );
      if (
        operationGeneration !== sftpOperationGenerationRef.current ||
        sftpSessionIdRef.current !== activeSessionId
      ) {
        return;
      }
      setSftpTransferResult({ direction: "upload", summary });
      const directory = await ipc.listSftpDirectory(
        activeSessionId,
        sftpDirectory?.path ?? ".",
      );
      if (
        operationGeneration !== sftpOperationGenerationRef.current ||
        sftpSessionIdRef.current !== activeSessionId
      ) {
        return;
      }
      setSftpDirectory(directory);
    } catch (error) {
      if (operationGeneration === sftpOperationGenerationRef.current) {
        setErrorMessage(localizedErrorText(error));
      }
    } finally {
      if (operationGeneration === sftpOperationGenerationRef.current) {
        setSftpBusy(false);
        setSftpTransferActive(false);
      }
    }
  };

  const downloadSftp = async (remotePath: string, localPath: string) => {
    const activeSessionId = sftpSessionIdRef.current;
    if (!activeSessionId) {
      return;
    }
    const operationGeneration = sftpOperationGenerationRef.current;

    setSftpBusy(true);
    setSftpTransferActive(true);
    setErrorMessage(null);
    setSftpTransferResult(null);
    try {
      const summary = await ipc.downloadSftpFile(
        activeSessionId,
        remotePath,
        localPath,
        language,
      );
      if (
        operationGeneration !== sftpOperationGenerationRef.current ||
        sftpSessionIdRef.current !== activeSessionId
      ) {
        return;
      }
      setSftpTransferResult({ direction: "download", summary });
    } catch (error) {
      if (operationGeneration === sftpOperationGenerationRef.current) {
        setErrorMessage(localizedErrorText(error));
      }
    } finally {
      if (operationGeneration === sftpOperationGenerationRef.current) {
        setSftpBusy(false);
        setSftpTransferActive(false);
      }
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

  const copyTerminalSelection = async (selection?: string) => {
    const text = selection ?? terminalRef.current?.getSelection() ?? "";
    if (!text) return;

    try {
      await ipc.writeClipboardText(text);
      setTerminalInteractionError(null);
    } catch (error) {
      setTerminalInteractionError(localizedErrorText(error));
    }
  };

  const pasteTerminalText = (text: string) => {
    if (!sessionIdRef.current || !text) return;
    terminalRef.current?.paste(text);
    terminalRef.current?.focus();
    setTerminalInteractionError(null);
  };

  const requestTerminalPaste = async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || terminalClipboardPendingRef.current) return;

    terminalClipboardPendingRef.current = true;
    setTerminalClipboardPending(true);
    setTerminalInteractionError(null);
    try {
      const text = await ipc.readClipboardText();
      if (sessionIdRef.current !== activeSessionId || !text) return;
      const details = terminalPasteDetails(text);
      if (details.requiresConfirmation) {
        setPendingTerminalPaste({ text, ...details });
      } else {
        pasteTerminalText(text);
      }
    } catch (error) {
      setTerminalInteractionError(localizedErrorText(error));
    } finally {
      terminalClipboardPendingRef.current = false;
      setTerminalClipboardPending(false);
    }
  };

  const confirmTerminalPaste = () => {
    const pending = pendingTerminalPaste;
    setPendingTerminalPaste(null);
    if (pending) pasteTerminalText(pending.text);
  };

  const requestExternalTerminalLink = (value: string) => {
    const link = parseExternalHttpLink(value);
    if (!link) {
      setTerminalInteractionError(t("terminal.externalLinkInvalid"));
      return;
    }
    setExternalLinkError(null);
    setExternalTerminalLink(link);
  };

  const confirmExternalTerminalLink = async () => {
    const link = externalTerminalLink;
    if (!link || externalLinkPending) return;

    setExternalLinkPending(true);
    setExternalLinkError(null);
    try {
      await ipc.openExternalUrl(link.url);
      setExternalTerminalLink(null);
    } catch (error) {
      setExternalLinkError(localizedErrorText(error));
    } finally {
      setExternalLinkPending(false);
    }
  };

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
  const currentSessionCloseImpact = {
    activeSessions: Number(sessionId !== null) + Number(sftpSessionId !== null),
    activeTransfers: Number(sftpTransferActive),
  };

  return (
    <div className="app-shell">
      <WindowTitleBar
        appName={appInfo.name}
        connectionLabel={connectionLabel(connectionState, connectionStage, t)}
        connectionState={connectionState}
        connectionSearch={connectionSearch}
        onConnectionSearchChange={setConnectionSearch}
        onCheckForUpdates={() => setUpdateRequestId((current) => current + 1)}
        onNewConnection={openNewConnectionEditor}
        onToggleSettings={() => setSettingsOpen((current) => !current)}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onWorkspaceModeChange={selectWorkspaceMode}
        updateRequestId={updateRequestId}
        version={appInfo.version}
        workspaceMode={workspaceMode}
        workspaceModeLocked={connected || busy}
        sidebarCollapsed={sidebarCollapsed}
        settingsOpen={settingsOpen}
      />

      <div
        className={`workspace${sidebarResizing ? " is-resizing-sidebar" : ""}`}
        style={{
          gridTemplateColumns: `${sidebarCollapsed ? 0 : sidebarWidth}px minmax(0, 1fr)`,
        }}
      >
        <aside
          className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
          aria-label={t("connection.sidebar")}
        >
          <div className="sidebar-heading">
            <h1>{t("connection.title")}</h1>
            <div className="sidebar-heading-actions">
              <span>
                {workspaceMode === "terminal"
                  ? t("terminal.protocol")
                  : t("sftp.protocol")}
              </span>
            </div>
          </div>

          <div className="connection-draft-actions">
            <Button
              icon={<Plus size={15} />}
              onClick={openNewConnectionEditor}
              block
            >
              {t("connectionEditor.actions.newConnection")}
            </Button>
            <Button
              aria-label={t("connectionGroup.new")}
              icon={<FolderPlus size={15} />}
              onClick={openNewConnectionGroup}
            />
            <Button
              aria-label={t("connectionImport.action")}
              icon={<FileInput size={15} />}
              onClick={openOpenSshImport}
            />
            <Button
              aria-label={t("connectionCatalog.refresh")}
              icon={<RefreshCw size={15} />}
              loading={connectionCatalogLoading}
              onClick={() => void loadConnectionCatalog()}
            />
          </div>

          {connectionCatalogNotice && (
            <FeedbackNotice
              className="connection-draft-notice"
              closable
              message={connectionCatalogNotice}
              onClose={() => setConnectionCatalogNotice(null)}
              showIcon
              type="success"
            />
          )}

          {!connectionSearch.trim() && (
            <div role="group" aria-label={t("connectionListView.label")}>
              <Segmented<ConnectionListMode>
                className="connection-list-mode"
                block
                value={connectionListMode}
                options={[
                  {
                    value: "connections",
                    label: t("connectionListView.connections"),
                    icon: <Server size={13} />,
                  },
                  {
                    value: "recent",
                    label: t("connectionListView.recent"),
                    icon: <History size={13} />,
                  },
                ]}
                onChange={setConnectionListMode}
              />
            </div>
          )}

          <section
            className="connection-catalog"
            aria-label={
              connectionListMode === "recent" && !connectionSearch.trim()
                ? t("connectionListView.recent")
                : t("connectionCatalog.title")
            }
          >
            <div className="connection-catalog-heading">
              <span>
                {connectionSearch.trim()
                  ? t("connectionSearch.title")
                  : connectionListMode === "recent"
                    ? t("connectionListView.recent")
                    : t("connectionCatalog.title")}
              </span>
              {!connectionCatalogLoading && !connectionCatalogError && (
                <span>
                  {connectionSearch.trim()
                    ? t("connectionSearch.resultCount", {
                        count: connectionSearchResults.length,
                      })
                    : connectionListMode === "recent"
                      ? allRecentConnections.length
                      : connectionCatalog.connections.length}
                </span>
              )}
            </div>

            {connectionCatalogLoading ? (
              <LoadingState label={t("connectionCatalog.loading")} />
            ) : connectionCatalogError ? (
              <FeedbackNotice
                message={t("connectionCatalog.loadFailed")}
                description={connectionCatalogError}
                showIcon
                type="error"
                action={
                  <Button
                    size="small"
                    onClick={() => void loadConnectionCatalog()}
                  >
                    {t("connectionCatalog.retry")}
                  </Button>
                }
              />
            ) : connectionSearch.trim() &&
              connectionSearchResults.length === 0 ? (
              <EmptyState
                className="connection-catalog-empty"
                icon={<Search size={24} strokeWidth={1.4} />}
                title={t("connectionSearch.emptyTitle")}
                description={t("connectionSearch.emptyDescription", {
                  query: connectionSearch.trim(),
                })}
                action={
                  <Button size="small" onClick={() => setConnectionSearch("")}>
                    {t("connectionSearch.clear")}
                  </Button>
                }
              />
            ) : connectionListMode === "recent" && !connectionSearch.trim() ? (
              allRecentConnections.length > 0 ? (
                <div className="connection-recent-list">
                  {allRecentConnections.map((item) => (
                    <article
                      className="connection-recent-item"
                      key={item.config.id}
                      role="group"
                      tabIndex={0}
                      aria-label={t("connectionListView.openNamed", {
                        name: item.config.name,
                      })}
                      onClick={() => void loadSavedConnection(item)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        void loadSavedConnection(item);
                      }}
                    >
                      <span
                        className="connection-catalog-color"
                        style={
                          item.config.color
                            ? { backgroundColor: item.config.color }
                            : undefined
                        }
                        aria-hidden="true"
                      />
                      <span className="connection-catalog-summary">
                        <strong title={item.config.name}>
                          {item.config.name}
                        </strong>
                        <span>
                          {t("connectionWorkspace.recentMetadata", {
                            count: item.successfulConnectionCount,
                            time: formatConnectionTime(
                              item.lastConnectedAt,
                              language,
                            ),
                          })}
                        </span>
                      </span>
                      <Button
                        aria-label={t("connectionListView.openNamed", {
                          name: item.config.name,
                        })}
                        icon={<PlugZap size={13} />}
                        loading={connectionActionId === item.config.id}
                        size="small"
                        type="text"
                        onClick={(event) => {
                          event.stopPropagation();
                          void loadSavedConnection(item);
                        }}
                      />
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  className="connection-catalog-empty"
                  icon={<History size={24} strokeWidth={1.4} />}
                  title={t("connectionListView.emptyTitle")}
                  description={t("connectionListView.emptyDescription")}
                  action={
                    <Button
                      size="small"
                      onClick={() => setConnectionListMode("connections")}
                    >
                      {t("connectionListView.showConnections")}
                    </Button>
                  }
                />
              )
            ) : connectionCatalog.connections.length === 0 &&
              connectionCatalog.groups.length === 0 ? (
              <EmptyState
                className="connection-catalog-empty"
                title={t("connectionCatalog.empty")}
                description={t("connectionCatalog.emptyDescription")}
              />
            ) : connectionSearch.trim() ? (
              <div className="connection-search-results">
                {connectionSearchResults.map(({ item, matchedFields }) => (
                  <article
                    className="connection-search-item"
                    key={item.config.id}
                  >
                    <span
                      className="connection-catalog-color"
                      style={
                        item.config.color
                          ? { backgroundColor: item.config.color }
                          : undefined
                      }
                      aria-hidden="true"
                    />
                    <span className="connection-catalog-summary">
                      <strong>{item.config.name}</strong>
                      <span>
                        {item.config.username}@{item.config.host}:
                        {item.config.port}
                      </span>
                      <span className="connection-search-match">
                        {t("connectionSearch.matchedFields", {
                          fields: matchedFields
                            .map((field) =>
                              t(`connectionSearch.fields.${field}`),
                            )
                            .join(t("connectionSearch.fieldSeparator")),
                        })}
                      </span>
                    </span>
                    <Button
                      aria-label={t("connectionSearch.openNamed", {
                        name: item.config.name,
                      })}
                      size="small"
                      loading={connectionActionId === item.config.id}
                      onClick={() => void loadSavedConnection(item)}
                    >
                      {t("connectionSearch.open")}
                    </Button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="connection-catalog-list">
                {connectionTree.map(({ group, connections }, groupIndex) => {
                  const collapsed = group?.isCollapsed ?? false;
                  const groupName =
                    group?.name ?? t("connectionGroup.ungrouped");
                  return (
                    <section
                      className="connection-tree-group"
                      key={group?.id ?? "ungrouped"}
                      aria-label={groupName}
                    >
                      <div className="connection-tree-group-heading">
                        {group ? (
                          <Button
                            aria-label={t(
                              collapsed
                                ? "connectionGroup.expandNamed"
                                : "connectionGroup.collapseNamed",
                              { name: group.name },
                            )}
                            icon={
                              collapsed ? (
                                <ChevronRight size={14} />
                              ) : (
                                <ChevronDown size={14} />
                              )
                            }
                            loading={
                              catalogMutationKey ===
                              `group-collapse:${group.id}`
                            }
                            size="small"
                            type="text"
                            onClick={() => void toggleConnectionGroup(group)}
                          />
                        ) : (
                          <span className="connection-tree-group-spacer" />
                        )}
                        <span
                          className="connection-tree-group-color"
                          style={
                            group?.color
                              ? { backgroundColor: group.color }
                              : undefined
                          }
                          aria-hidden="true"
                        />
                        <strong title={groupName}>{groupName}</strong>
                        <span className="connection-tree-group-count">
                          {connections.length}
                        </span>
                        {group && (
                          <div className="connection-tree-group-actions">
                            <Button
                              aria-label={t("connectionGroup.moveUpNamed", {
                                name: group.name,
                              })}
                              disabled={
                                groupIndex === 0 || catalogMutationKey !== null
                              }
                              icon={<MoveUp size={13} />}
                              size="small"
                              type="text"
                              onClick={() =>
                                void moveConnectionGroup(group.id, -1)
                              }
                            />
                            <Button
                              aria-label={t("connectionGroup.moveDownNamed", {
                                name: group.name,
                              })}
                              disabled={
                                groupIndex ===
                                  connectionCatalog.groups.length - 1 ||
                                catalogMutationKey !== null
                              }
                              icon={<MoveDown size={13} />}
                              size="small"
                              type="text"
                              onClick={() =>
                                void moveConnectionGroup(group.id, 1)
                              }
                            />
                            <Button
                              aria-label={t("connectionGroup.editNamed", {
                                name: group.name,
                              })}
                              icon={<FilePenLine size={13} />}
                              size="small"
                              type="text"
                              onClick={() => openConnectionGroupEditor(group)}
                            />
                            <Button
                              aria-label={t("connectionGroup.deleteNamed", {
                                name: group.name,
                              })}
                              danger
                              icon={<Trash2 size={13} />}
                              size="small"
                              type="text"
                              onClick={() => {
                                setDeleteGroupError(null);
                                setDeleteGroupTarget(group);
                              }}
                            />
                          </div>
                        )}
                      </div>
                      {!collapsed && (
                        <div className="connection-tree-items">
                          {connections.map((item, itemIndex) => {
                            const peers = connections.filter(
                              (peer) => peer.isFavorite === item.isFavorite,
                            );
                            const peerIndex = peers.findIndex(
                              (peer) => peer.config.id === item.config.id,
                            );
                            const effectiveColor =
                              item.config.color ?? group?.color ?? undefined;
                            return (
                              <article
                                className="connection-catalog-item"
                                key={item.config.id}
                                data-tree-index={itemIndex}
                                role="group"
                                tabIndex={0}
                                aria-label={t("connectionListView.openNamed", {
                                  name: item.config.name,
                                })}
                                onDoubleClick={() =>
                                  void loadSavedConnection(item)
                                }
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  void loadSavedConnection(item);
                                }}
                              >
                                <span
                                  className="connection-catalog-color"
                                  style={
                                    effectiveColor
                                      ? { backgroundColor: effectiveColor }
                                      : undefined
                                  }
                                  aria-hidden="true"
                                />
                                <div className="connection-catalog-summary">
                                  <strong title={item.config.name}>
                                    {item.config.name}
                                  </strong>
                                  <span
                                    title={`${item.config.username}@${item.config.host}:${item.config.port}`}
                                  >
                                    {item.config.username}@{item.config.host}:
                                    {item.config.port}
                                  </span>
                                </div>
                                <div className="connection-catalog-actions">
                                  <Button
                                    aria-label={t(
                                      "connectionListView.openNamed",
                                      { name: item.config.name },
                                    )}
                                    icon={<PlugZap size={13} />}
                                    loading={
                                      connectionActionId === item.config.id
                                    }
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void loadSavedConnection(item);
                                    }}
                                  />
                                  <Button
                                    aria-label={t(
                                      item.isFavorite
                                        ? "connectionCatalog.unfavoriteNamed"
                                        : "connectionCatalog.favoriteNamed",
                                      { name: item.config.name },
                                    )}
                                    className={
                                      item.isFavorite
                                        ? "is-favorite"
                                        : undefined
                                    }
                                    icon={
                                      <Star
                                        size={14}
                                        fill={
                                          item.isFavorite
                                            ? "currentColor"
                                            : "none"
                                        }
                                      />
                                    }
                                    loading={
                                      catalogMutationKey ===
                                      `favorite:${item.config.id}`
                                    }
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void toggleFavoriteConnection(item);
                                    }}
                                  />
                                  <Button
                                    aria-label={t(
                                      "connectionCatalog.moveUpNamed",
                                      {
                                        name: item.config.name,
                                      },
                                    )}
                                    disabled={
                                      peerIndex === 0 ||
                                      catalogMutationKey !== null
                                    }
                                    icon={<MoveUp size={13} />}
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void moveConnection(
                                        item,
                                        connections,
                                        -1,
                                      );
                                    }}
                                  />
                                  <Button
                                    aria-label={t(
                                      "connectionCatalog.moveDownNamed",
                                      {
                                        name: item.config.name,
                                      },
                                    )}
                                    disabled={
                                      peerIndex === peers.length - 1 ||
                                      catalogMutationKey !== null
                                    }
                                    icon={<MoveDown size={13} />}
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void moveConnection(item, connections, 1);
                                    }}
                                  />
                                  <Button
                                    aria-label={t(
                                      "connectionCatalog.editNamed",
                                      {
                                        name: item.config.name,
                                      },
                                    )}
                                    icon={<FilePenLine size={14} />}
                                    loading={
                                      connectionActionId === item.config.id
                                    }
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void openSavedConnectionEditor(
                                        item,
                                        false,
                                      );
                                    }}
                                  />
                                  <Button
                                    aria-label={t(
                                      "connectionCatalog.copyNamed",
                                      {
                                        name: item.config.name,
                                      },
                                    )}
                                    disabled={
                                      connectionActionId === item.config.id
                                    }
                                    icon={<Copy size={14} />}
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void openSavedConnectionEditor(
                                        item,
                                        true,
                                      );
                                    }}
                                  />
                                  <Button
                                    aria-label={t(
                                      "connectionCatalog.deleteNamed",
                                      {
                                        name: item.config.name,
                                      },
                                    )}
                                    danger
                                    disabled={
                                      connectionActionId === item.config.id
                                    }
                                    icon={<Trash2 size={14} />}
                                    size="small"
                                    type="text"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setDeleteError(null);
                                      setDeleteTarget(item);
                                    }}
                                  />
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </section>

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
                  setConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
                  setActiveSessionTab(null);
                  setLoadedConnectionId(null);
                  loadedConnectionIdRef.current = null;
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
                  setConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
                  setActiveSessionTab(null);
                  setLoadedConnectionId(null);
                  loadedConnectionIdRef.current = null;
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
                onChange={(event) => {
                  setUsername(event.target.value);
                  setConnectionSettings(DEFAULT_CONNECTION_SETTINGS);
                  setActiveSessionTab(null);
                  setLoadedConnectionId(null);
                  loadedConnectionIdRef.current = null;
                }}
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

            {!activeSessionId && connectionState === "connecting" ? (
              <Button
                danger
                icon={<CircleX size={15} />}
                onClick={cancelDirectConnection}
                block
              >
                {t("connection.cancel")}
              </Button>
            ) : !activeSessionId &&
              connectionState === "disconnected" &&
              activeSessionTab ? (
              <Button
                type="primary"
                icon={<RefreshCw size={15} />}
                disabled={busy}
                onClick={() => void reconnectSession()}
                block
              >
                {t("connection.reconnect")}
              </Button>
            ) : !activeSessionId ? (
              <Button
                type="primary"
                icon={<PlugZap size={15} />}
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
                onClick={requestSessionClose}
                block
              >
                {t("connection.disconnect")}
              </Button>
            )}
          </div>

          {errorMessage && (
            <FeedbackNotice
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

        {!sidebarCollapsed && (
          <div
            className="sidebar-resizer"
            style={{ left: sidebarWidth - 3 }}
            role="separator"
            tabIndex={0}
            aria-label={t("connectionSidebar.resize")}
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            aria-valuenow={sidebarWidth}
            aria-valuetext={t("connectionSidebar.widthValue", {
              width: sidebarWidth,
            })}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
            onKeyDown={resizeSidebarByKeyboard}
            onPointerDown={startSidebarResize}
          />
        )}

        <main
          className={`session-workspace${activeSessionTab ? " has-session-tab" : ""}`}
        >
          {activeSessionTab && (
            <SessionTabBar
              closing={connectionState === "closing"}
              connectionState={connectionState}
              disabled={busy || connectionLaunchStep !== undefined}
              statusLabel={connectionLabel(connectionState, connectionStage, t)}
              tab={activeSessionTab}
              onClose={requestSessionClose}
            />
          )}
          <div className="session-workspace-content">
            {workspaceMode === "terminal" ? (
              <section className="terminal-workspace">
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
                  <div className="terminal-toolbar-actions">
                    <Tooltip
                      title={`${t("terminal.copySelection")} (Ctrl+Shift+C)`}
                    >
                      <Button
                        aria-label={t("terminal.copySelection")}
                        disabled={!terminalSelection}
                        icon={<Copy size={14} />}
                        size="small"
                        type="text"
                        onClick={() => void copyTerminalSelection()}
                      />
                    </Tooltip>
                    <Tooltip title={`${t("terminal.paste")} (Ctrl+Shift+V)`}>
                      <Button
                        aria-label={t("terminal.paste")}
                        disabled={sessionId === null}
                        icon={<ClipboardPaste size={14} />}
                        loading={terminalClipboardPending}
                        size="small"
                        type="text"
                        onClick={() => void requestTerminalPaste()}
                      />
                    </Tooltip>
                  </div>
                </div>
                <div className="terminal-stage">
                  <TerminalPane
                    key={activeSessionTab?.clientId ?? "terminal-empty"}
                    ref={terminalRef}
                    connected={connected}
                    sessionKey={activeSessionTab?.clientId}
                    onCopySelection={(selection) =>
                      void copyTerminalSelection(selection)
                    }
                    onData={writeTerminal}
                    onOpenLink={requestExternalTerminalLink}
                    onPasteRequest={() => void requestTerminalPaste()}
                    onResize={resizeTerminal}
                    onSelectionChange={setTerminalSelection}
                  />
                  {terminalInteractionError && (
                    <FeedbackNotice
                      className="terminal-operation-error"
                      closable
                      message={t("terminal.operationFailed")}
                      description={terminalInteractionError}
                      showIcon
                      type="error"
                      onClose={() => setTerminalInteractionError(null)}
                    />
                  )}
                  {!connected &&
                    (connectionState === "idle" && !hostKey ? (
                      <ConnectionWorkspaceEmptyState
                        language={language}
                        loadingConnectionId={connectionActionId}
                        recentConnections={recentConnections}
                        totalConnections={connectionCatalog.connections.length}
                        onImportConfig={openOpenSshImport}
                        onNewConnection={openNewConnectionEditor}
                        onQuickConnect={(item) =>
                          void loadSavedConnection(item)
                        }
                      />
                    ) : (
                      <EmptyState
                        className="terminal-empty"
                        icon={<SquareTerminal size={36} strokeWidth={1.3} />}
                        title={connectionLabel(
                          connectionState,
                          connectionStage,
                          t,
                        )}
                      />
                    ))}
                </div>
              </section>
            ) : (
              <section className="sftp-workspace">
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
                {!connected && connectionState === "idle" && !hostKey && (
                  <ConnectionWorkspaceEmptyState
                    language={language}
                    loadingConnectionId={connectionActionId}
                    recentConnections={recentConnections}
                    totalConnections={connectionCatalog.connections.length}
                    onImportConfig={openOpenSshImport}
                    onNewConnection={openNewConnectionEditor}
                    onQuickConnect={(item) => void loadSavedConnection(item)}
                  />
                )}
              </section>
            )}
          </div>
        </main>

        {settingsOpen && (
          <SettingsView
            appName={appInfo.name}
            groups={connectionCatalog.groups}
            left={sidebarCollapsed ? 0 : sidebarWidth}
            version={appInfo.version}
            onCheckForUpdates={() =>
              setUpdateRequestId((current) => current + 1)
            }
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      <footer className={`statusbar${connected ? " is-connected" : ""}`}>
        <span className="status-item">
          {connected ? <Wifi size={10} /> : <WifiOff size={10} />}
          {!connected && settingsOpen
            ? t("settings.title")
            : connectionLabel(connectionState, connectionStage, t)}
        </span>
        <span className="status-spacer" />
        {connected && (
          <>
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
          </>
        )}
        <Tooltip title={t("settings.title")}>
          <button
            aria-label={t("settings.open")}
            className="statusbar-settings"
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={10} />
          </button>
        </Tooltip>
      </footer>

      <ConnectionLaunchDialog
        key={`connection-launch-${activeSessionTab?.clientId ?? "closed"}`}
        connectionName={activeSessionTab?.name ?? ""}
        endpoint={activeSessionTab?.endpoint ?? ""}
        errorMessage={
          connectionState === "failed" ? (errorMessage ?? undefined) : undefined
        }
        hostKey={hostKey ?? undefined}
        initialPassword={launchCredentialPassword}
        pending={
          fingerprintTrustPending ||
          keyboardInteractiveResponsePending ||
          (connectionState === "connecting" && !keyboardInteractivePrompt)
        }
        step={activeSessionTab ? connectionLaunchStep : undefined}
        authMethod={launchAuthMethod}
        keyboardPrompt={keyboardInteractivePrompt}
        onCancel={cancelConnectionFlow}
        onConfirmFingerprint={confirmConnectionFingerprint}
        initialCredentialMode={launchCredentialMode}
        onSubmitPassword={(credential, mode) =>
          void authenticatePendingConnection(credential, mode)
        }
        onSubmitKeyboardInteractive={submitKeyboardInteractive}
      />

      <AppDialog
        open={pendingTerminalPaste !== null}
        title={t("terminal.pasteConfirmTitle")}
        description={
          pendingTerminalPaste
            ? t("terminal.pasteConfirmDescription", {
                characters: pendingTerminalPaste.characterCount,
                lines: pendingTerminalPaste.lineCount,
              })
            : undefined
        }
        initialFocusRef={terminalPasteCancelButtonRef}
        onClose={() => setPendingTerminalPaste(null)}
        footer={
          <>
            <Button
              ref={terminalPasteCancelButtonRef}
              onClick={() => setPendingTerminalPaste(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={confirmTerminalPaste}>
              {t("terminal.confirmPaste")}
            </Button>
          </>
        }
      >
        {pendingTerminalPaste && (
          <pre
            aria-label={t("terminal.pastePreview")}
            className="terminal-paste-preview"
          >
            {pendingTerminalPaste.text}
          </pre>
        )}
      </AppDialog>

      <AppDialog
        open={externalTerminalLink !== null}
        title={t("terminal.externalLinkTitle")}
        description={t("terminal.externalLinkDescription")}
        closable={!externalLinkPending}
        closeOnEscape={!externalLinkPending}
        initialFocusRef={externalLinkCancelButtonRef}
        onClose={() => {
          if (!externalLinkPending) {
            setExternalTerminalLink(null);
            setExternalLinkError(null);
          }
        }}
        footer={
          <>
            <Button
              ref={externalLinkCancelButtonRef}
              disabled={externalLinkPending}
              onClick={() => {
                setExternalTerminalLink(null);
                setExternalLinkError(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              loading={externalLinkPending}
              type="primary"
              onClick={() => void confirmExternalTerminalLink()}
            >
              {t("terminal.openExternalLink")}
            </Button>
          </>
        }
      >
        {externalTerminalLink && (
          <dl className="terminal-external-link-details">
            <dt>{t("terminal.externalLinkHost")}</dt>
            <dd>{externalTerminalLink.host}</dd>
            <dt>{t("terminal.externalLinkUrl")}</dt>
            <dd>{externalTerminalLink.url}</dd>
          </dl>
        )}
        {externalLinkError && (
          <FeedbackNotice
            message={t("terminal.externalLinkFailed")}
            description={externalLinkError}
            showIcon
            type="error"
          />
        )}
      </AppDialog>

      <AppDialog
        open={sessionCloseOpen}
        title={t("sessionClose.title")}
        closable={!sessionClosePending}
        closeOnEscape={!sessionClosePending}
        maskClosable={false}
        initialFocusRef={sessionCloseCancelButtonRef}
        onClose={cancelSessionClose}
        description={
          sessionCloseOpen
            ? sessionCloseImpactMessage(
                currentSessionCloseImpact,
                activeSessionTab?.name,
                t,
                language,
              )
            : undefined
        }
        footer={
          <>
            <Button
              ref={sessionCloseCancelButtonRef}
              disabled={sessionClosePending}
              onClick={cancelSessionClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              danger
              loading={sessionClosePending}
              type="primary"
              onClick={() => void confirmSessionClose()}
            >
              {t("sessionClose.confirm")}
            </Button>
          </>
        }
      >
        {sessionCloseError && (
          <FeedbackNotice
            type="error"
            showIcon
            message={t("sessionClose.error")}
            description={sessionCloseError}
          />
        )}
      </AppDialog>

      <AppDialog
        open={exitImpact !== null}
        title={t("exit.title")}
        closable={false}
        closeOnEscape={!exitPending}
        maskClosable={false}
        initialFocusRef={exitCancelButtonRef}
        onClose={cancelAppExit}
        description={
          exitImpact ? exitImpactMessage(exitImpact, t, language) : undefined
        }
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
      >
        {exitError && (
          <FeedbackNotice
            type="error"
            showIcon
            message={t("exit.error")}
            description={exitError}
          />
        )}
      </AppDialog>

      <AppDialog
        open={deleteTarget !== null}
        title={t("connectionCatalog.deleteTitle")}
        closable={!deletePending}
        closeOnEscape={!deletePending}
        maskClosable={false}
        initialFocusRef={deleteCancelButtonRef}
        onClose={() => {
          if (!deletePending) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        description={
          deleteTarget
            ? t("connectionCatalog.deleteDescription", {
                name: deleteTarget.config.name,
              })
            : undefined
        }
        footer={
          <>
            <Button
              ref={deleteCancelButtonRef}
              disabled={deletePending}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              aria-label={t("connectionCatalog.confirmDelete")}
              danger
              loading={deletePending}
              type="primary"
              onClick={() => void confirmDeleteConnection()}
            >
              {t("connectionCatalog.confirmDelete")}
            </Button>
          </>
        }
      >
        <FeedbackNotice
          message={t("connectionCatalog.remoteDataSafe")}
          showIcon
          type="warning"
        />
        {deleteTarget &&
          activeSessionTab?.connectionId === deleteTarget.config.id &&
          (sessionId !== null || sftpSessionId !== null) && (
            <FeedbackNotice
              message={t("connectionCatalog.activeSessionUnaffected")}
              showIcon
              type="info"
            />
          )}
        {deleteError && (
          <FeedbackNotice
            className="connection-delete-error"
            message={t("connectionCatalog.deleteFailed")}
            description={deleteError}
            showIcon
            type="error"
          />
        )}
      </AppDialog>

      <AppDialog
        open={deleteGroupTarget !== null}
        title={t("connectionGroup.deleteTitle")}
        closable={!deleteGroupPending}
        closeOnEscape={!deleteGroupPending}
        maskClosable={false}
        onClose={() => {
          if (!deleteGroupPending) {
            setDeleteGroupTarget(null);
            setDeleteGroupError(null);
          }
        }}
        description={
          deleteGroupTarget
            ? t("connectionGroup.deleteDescription", {
                name: deleteGroupTarget.name,
              })
            : undefined
        }
        footer={
          <>
            <Button
              disabled={deleteGroupPending}
              onClick={() => {
                setDeleteGroupTarget(null);
                setDeleteGroupError(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              danger
              loading={deleteGroupPending}
              type="primary"
              onClick={() => void confirmDeleteConnectionGroup()}
            >
              {t("connectionGroup.confirmDelete")}
            </Button>
          </>
        }
      >
        <FeedbackNotice
          message={t("connectionGroup.deleteSafety")}
          showIcon
          type="warning"
        />
        {deleteGroupError && (
          <FeedbackNotice
            className="connection-delete-error"
            message={t("connectionGroup.deleteFailed")}
            description={deleteGroupError}
            showIcon
            type="error"
          />
        )}
      </AppDialog>

      <ConnectionGroupDialog
        key={
          connectionGroupDialogOpen
            ? (connectionGroupInitialValue?.id ?? "new")
            : "connection-group-closed"
        }
        errorMessage={connectionGroupError ?? undefined}
        initialValue={connectionGroupInitialValue}
        open={connectionGroupDialogOpen}
        pending={connectionGroupPending}
        onClose={() => {
          if (!connectionGroupPending) {
            setConnectionGroupDialogOpen(false);
            setConnectionGroupError(null);
          }
        }}
        onSubmit={(group) => void saveConnectionGroup(group)}
      />

      <OpenSshImportDialog
        key={
          openSshImportPreview
            ? `${openSshImportPreview.sourcePath}:${openSshImportPreview.items.map((item) => item.sourceId).join("|")}`
            : openSshImportOpen
              ? "loading"
              : "openssh-import-closed"
        }
        errorMessage={openSshImportError ?? undefined}
        loading={openSshImportLoading}
        open={openSshImportOpen}
        pending={openSshImportPending}
        preview={openSshImportPreview}
        onBrowse={() => void browseOpenSshConfig()}
        onClose={() => {
          if (!openSshImportPending) {
            setOpenSshImportOpen(false);
            setOpenSshImportError(null);
          }
        }}
        onLoadDefault={() => void loadOpenSshImportPreview(null)}
        onSubmit={(request) => void importOpenSshConnections(request)}
      />

      <ConnectionEditorDialog
        errorMessage={connectionEditorError ?? undefined}
        groupOptions={connectionCatalog.groups.map((group) => ({
          label: group.name,
          value: group.id,
        }))}
        initialValue={connectionEditorInitialValue}
        notice={connectionEditorNotice}
        open={connectionEditorOpen}
        pending={connectionEditorPending}
        saveAndConnectDisabled={connected || busy || activeSessionId !== null}
        onClose={() => {
          if (!connectionEditorPending) {
            setConnectionEditorOpen(false);
            setConnectionEditorError(null);
          }
        }}
        onSubmit={(value, intent) => void saveConnection(value, intent)}
      />
    </div>
  );
}

function connectionDetailsToEditorValue(
  details: ConnectionDetails,
): ConnectionEditorValue {
  return {
    config: details.connection.config,
    settings: details.settings.layers.connection ?? {
      connectTimeoutSecs: null,
      keepAliveSecs: null,
    },
    credentialMode: details.connection.config.credentialRef ? "vault" : "ask",
  };
}

function duplicateConnection(
  details: ConnectionDetails,
  t: TFunction,
): ConnectionEditorValue {
  const value = connectionDetailsToEditorValue(details);
  return {
    config: {
      ...value.config,
      id: createConnectionId(),
      name: t("connectionCatalog.copyName", { name: value.config.name }),
    },
    settings: value.settings,
  };
}

function createConnectionId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return `connection-${id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function buildConnectionTree(
  catalog: ConnectionCatalog,
): ConnectionTreeGroup[] {
  const groups = [...catalog.groups].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
  const groupedConnections = new Map<string | null, ConnectionListItem[]>();
  for (const item of catalog.connections) {
    const groupId = groups.some((group) => group.id === item.config.groupId)
      ? item.config.groupId
      : null;
    const items = groupedConnections.get(groupId) ?? [];
    items.push(item);
    groupedConnections.set(groupId, items);
  }
  const sortConnections = (items: ConnectionListItem[]) =>
    [...items].sort(
      (left, right) =>
        Number(right.isFavorite) - Number(left.isFavorite) ||
        left.sortOrder - right.sortOrder ||
        left.config.name.localeCompare(right.config.name) ||
        left.config.id.localeCompare(right.config.id),
    );
  const tree: ConnectionTreeGroup[] = groups.map((group) => ({
    group,
    connections: sortConnections(groupedConnections.get(group.id) ?? []),
  }));
  const ungrouped = sortConnections(groupedConnections.get(null) ?? []);
  if (ungrouped.length > 0) {
    tree.push({ group: null, connections: ungrouped });
  }
  return tree;
}

function searchConnections(
  catalog: ConnectionCatalog,
  query: string,
): ConnectionSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const groupNames = new Map(
    catalog.groups.map((group) => [group.id, group.name]),
  );
  const results: ConnectionSearchResult[] = [];
  for (const item of catalog.connections) {
    const fields: Array<[ConnectionSearchField, string | null | undefined]> = [
      ["name", item.config.name],
      ["host", item.config.host],
      ["username", item.config.username],
      [
        "group",
        item.config.groupId ? groupNames.get(item.config.groupId) : null,
      ],
      ["notes", item.config.notes],
    ];
    const normalizedFields = fields.map(([field, value]) => [
      field,
      value?.toLocaleLowerCase() ?? "",
    ]) as Array<[ConnectionSearchField, string]>;
    if (
      !tokens.every((token) =>
        normalizedFields.some(([, value]) => value.includes(token)),
      )
    ) {
      continue;
    }
    const matchedFields = normalizedFields
      .filter(([, value]) => tokens.some((token) => value.includes(token)))
      .map(([field]) => field);
    if (matchedFields.length > 0) {
      results.push({ item, matchedFields });
    }
  }
  return results.sort(
    (left, right) =>
      Number(right.item.isFavorite) - Number(left.item.isFavorite) ||
      left.item.config.name.localeCompare(right.item.config.name) ||
      left.item.config.id.localeCompare(right.item.config.id),
  );
}

function getRecentConnections(
  connections: ConnectionListItem[],
): ConnectionListItem[] {
  return connections
    .filter((item) => item.lastConnectedAt !== null)
    .sort(
      (left, right) =>
        (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0) ||
        right.successfulConnectionCount - left.successfulConnectionCount ||
        left.config.name.localeCompare(right.config.name),
    );
}

function formatConnectionTime(value: number | null, language: string): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored === null) return SIDEBAR_WIDTH_DEFAULT;
    const parsed = Number(stored);
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)),
  );
}

function moveId(ids: string[], id: string, direction: -1 | 1): boolean {
  const index = ids.indexOf(id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return false;
  [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
  return true;
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

function sessionCloseImpactMessage(
  impact: ExitImpact,
  sessionName: string | undefined,
  t: TFunction,
  language: string,
): string {
  const activity = [];
  if (impact.activeSessions > 0) {
    activity.push(
      t("sessionClose.activeSessions", { count: impact.activeSessions }),
    );
  }
  if (impact.activeTransfers > 0) {
    activity.push(
      t("sessionClose.activeTransfers", { count: impact.activeTransfers }),
    );
  }

  return t("sessionClose.message", {
    activity: new Intl.ListFormat(language, {
      style: "long",
      type: "conjunction",
    }).format(activity),
    name: sessionName ?? t("sessionClose.currentSession"),
  });
}

function connectionLabel(
  state: ConnectionState,
  stage: SshConnectionStage | null,
  t: TFunction,
): string {
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

  if (state !== "connecting" || !stage) {
    return labels[state];
  }

  const stageLabels: Partial<Record<SshConnectionStage, string>> = {
    created: t("status.stage.created"),
    resolvingDns: t("status.stage.resolvingDns"),
    connectingTcp: t("status.stage.connectingTcp"),
    handshaking: t("status.stage.handshaking"),
    authenticating: t("status.stage.authenticating"),
    openingChannel: t("status.stage.openingChannel"),
  };
  return stageLabels[stage] ?? labels[state];
}

function errorText(error: unknown, t: TFunction): string {
  if (error instanceof IpcError) {
    return commandErrorText(error.code, error.message, t);
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return t("errors.sshOperation");
}

function commandErrorText(
  code: string,
  fallback: string,
  t: TFunction,
): string {
  switch (code) {
    case "dns_lookup_timeout":
      return t("errors.dnsLookupTimeout");
    case "dns_lookup_failed":
      return t("errors.dnsLookupFailed");
    case "tcp_connect_timeout":
    case "connect_timeout":
      return t("errors.tcpConnectTimeout");
    case "connection_refused":
      return t("errors.connectionRefused");
    case "network_unreachable":
      return t("errors.networkUnreachable");
    case "tcp_connect_failed":
      return t("errors.tcpConnectFailed");
    case "handshake_timeout":
      return t("errors.handshakeTimeout");
    case "handshake_failed":
      return t("errors.handshakeFailed");
    case "host_key_mismatch":
      return t("errors.hostKeyMismatch");
    case "host_key_unavailable":
      return t("errors.hostKeyUnavailable");
    case "credential_store_locked":
      return t("errors.credentialStoreLocked");
    case "credential_store_unavailable":
      return t("errors.credentialStoreUnavailable");
    case "credential_store_failed":
      return t("errors.credentialStoreFailed");
    case "invalid_credential":
      return t("errors.invalidCredential");
    case "private_key_error":
      return t("errors.privateKeyError");
    case "authentication_rejected":
      return t("errors.authenticationRejected");
    case "legacy_rsa_signature_only":
      return t("errors.legacyRsaSignatureOnly");
    case "keep_alive_failed":
      return t("errors.keepAliveFailed");
    case "clipboard_unavailable":
      return t("terminal.clipboardUnavailable");
    case "invalid_external_url":
      return t("terminal.externalLinkInvalid");
    case "external_link_open_failed":
      return t("terminal.externalLinkFailed");
    default:
      return fallback;
  }
}

function isClosedSessionError(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.code === "session_not_found" || error.code === "session_closed")
  );
}

function createConnectionAttemptId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function setWebviewMemoryUsage(low: boolean): Promise<void> {
  await ipc.setWebviewMemoryUsage(low).catch(() => undefined);
}
