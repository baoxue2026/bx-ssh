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
  Circle,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePenLine,
  FileInput,
  Fingerprint,
  FolderPlus,
  FolderOpen,
  History,
  MoveDown,
  MoveUp,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  ScanSearch,
  Server,
  SquareTerminal,
  Star,
  Trash2,
  Unplug,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ConnectionEditorDialog,
  type ConnectionEditorIntent,
  type ConnectionEditorValue,
} from "./components/ConnectionEditorDialog";
import { ConnectionGroupDialog } from "./components/ConnectionGroupDialog";
import {
  ConnectionLaunchDialog,
  type ConnectionLaunchStep,
} from "./components/ConnectionLaunchDialog";
import { ConnectionWorkspaceEmptyState } from "./components/ConnectionWorkspaceEmptyState";
import { OpenSshImportDialog } from "./components/OpenSshImportDialog";
import { SessionTabBar, type SessionTab } from "./components/SessionTabBar";
import {
  TerminalPane,
  type TerminalHandle,
  type TerminalViewport,
} from "./components/TerminalPane";
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
  ExitImpact,
  HostKeyInfo,
  OpenSshImportPreview,
  OpenSshImportRequest,
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
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 420;
const SIDEBAR_WIDTH_DEFAULT = 240;
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
  const [hostKey, setHostKey] = useState<HostKeyInfo | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("terminal");
  const [connectionListMode, setConnectionListMode] =
    useState<ConnectionListMode>("connections");
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(readSidebarCollapsed);
  const [sidebarResizing, setSidebarResizing] = useState(false);
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
  const connectionFlowPendingRef = useRef(false);
  const sessionTabSequenceRef = useRef(0);
  const exitCancelButtonRef = useRef<HTMLButtonElement>(null);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const hostKeyRef = useRef<HostKeyInfo | null>(null);
  const localizedErrorText = useCallback(
    (error: unknown) => errorText(error, t("errors.sshOperation")),
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

  const probeHost = async (
    targetHost = host,
    targetPort = port,
  ): Promise<HostKeyInfo | null> => {
    setConnectionState("probing");
    setErrorMessage(null);
    setHostKey(null);
    setTrusted(false);

    try {
      const result = await ipc.probeSshHost({
        host: targetHost,
        port: targetPort,
      });
      setHostKey(result);
      setConnectionState("ready");
      return result;
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

  const beginConnectionFlow = async (config: ConnectionConfig) => {
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
    setPassword("");
    setLoadedConnectionId(config.id);
    loadedConnectionIdRef.current = config.id;
    resetHostTrust();

    if (config.authMethod !== "password") {
      setConnectionState("failed");
      setErrorMessage(
        t("connectionAuthentication.unsupported", {
          method: connectionAuthLabel(config.authMethod, t),
        }),
      );
      connectionFlowPendingRef.current = false;
      return;
    }

    const result = await probeHost(config.host, config.port);
    if (connectionAttemptRef.current === request && result) {
      setConnectionLaunchStep("fingerprint");
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
      await beginConnectionFlow(details.connection.config);
    } catch (error) {
      setConnectionCatalogError(localizedErrorText(error));
    } finally {
      setConnectionActionId(null);
    }
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
      await loadConnectionCatalog();
      setConnectionCatalogNotice(
        t("connectionCatalog.saved", {
          name: value.config.name,
        }),
      );
      setConnectionEditorOpen(false);

      if (intent === "saveAndConnect") {
        await beginConnectionFlow(value.config);
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

  const connectTerminal = async (
    passwordOverride?: string,
  ): Promise<boolean> => {
    const connectionPassword = passwordOverride ?? password;
    if (!hostKey || !trusted || !username || !connectionPassword) {
      return false;
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
          password: connectionPassword,
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
        return false;
      }

      setPassword("");
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
      setErrorMessage(localizedErrorText(error));
      setConnectionState("failed");
      return false;
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
      void recordLoadedConnectionSuccess();
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

  const confirmConnectionFingerprint = () => {
    setTrusted(true);
    setConnectionLaunchStep("password");
  };

  const cancelConnectionFlow = () => {
    connectionAttemptRef.current += 1;
    connectionFlowPendingRef.current = false;
    setConnectionLaunchStep(undefined);
    setPassword("");
    setTrusted(false);
    setHostKey(null);
    setConnectionState("idle");
    setActiveSessionTab(null);
    setLoadedConnectionId(null);
    loadedConnectionIdRef.current = null;
  };

  const authenticatePendingConnection = async (credential: string) => {
    connectionFlowPendingRef.current = true;
    const connectedSuccessfully = await connectTerminal(credential);
    if (connectedSuccessfully) {
      connectionFlowPendingRef.current = false;
      setConnectionLaunchStep(undefined);
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

  const closeActiveSessionTab = async () => {
    connectionAttemptRef.current += 1;
    connectionFlowPendingRef.current = false;
    if (sessionId || sftpSessionId) {
      await closeSession();
    }
    setConnectionLaunchStep(undefined);
    setConnectionState("idle");
    sessionIdRef.current = null;
    setSessionId(null);
    sftpSessionIdRef.current = null;
    setSftpSessionId(null);
    setSftpDirectory(null);
    setActiveSessionTab(null);
    setLoadedConnectionId(null);
    loadedConnectionIdRef.current = null;
    setHostKey(null);
    setTrusted(false);
    setPassword("");
    terminalRef.current?.reset();
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

      <div
        className={`workspace${sidebarResizing ? " is-resizing-sidebar" : ""}`}
        style={{
          gridTemplateColumns: `${sidebarCollapsed ? 32 : sidebarWidth}px minmax(0, 1fr)`,
        }}
      >
        <aside
          className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
          aria-label={t("connection.sidebar")}
        >
          <Tooltip title={t("connectionSidebar.expand")} placement="right">
            <Button
              className="sidebar-restore"
              aria-label={t("connectionSidebar.expand")}
              icon={<PanelLeftOpen size={15} />}
              size="small"
              type="text"
              onClick={() => setSidebarCollapsed(false)}
            />
          </Tooltip>
          <div className="sidebar-heading">
            <h1>{t("connection.title")}</h1>
            <div className="sidebar-heading-actions">
              <span>
                {workspaceMode === "terminal"
                  ? t("terminal.protocol")
                  : t("sftp.protocol")}
              </span>
              <Tooltip title={t("connectionSidebar.collapse")}>
                <Button
                  aria-label={t("connectionSidebar.collapse")}
                  icon={<PanelLeftClose size={14} />}
                  size="small"
                  type="text"
                  onClick={() => setSidebarCollapsed(true)}
                />
              </Tooltip>
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

          <Input
            allowClear
            aria-label={t("connectionSearch.label")}
            className="connection-search"
            placeholder={t("connectionSearch.placeholder")}
            prefix={<Search size={14} aria-hidden="true" />}
            value={connectionSearch}
            onChange={(event) => setConnectionSearch(event.target.value)}
          />

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
              statusLabel={connectionLabel(connectionState, t)}
              tab={activeSessionTab}
              onClose={() => void closeActiveSessionTab()}
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
                </div>
                <div className="terminal-stage">
                  <TerminalPane
                    ref={terminalRef}
                    connected={connected}
                    onData={writeTerminal}
                    onResize={resizeTerminal}
                  />
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
                        title={connectionLabel(connectionState, t)}
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

      <ConnectionLaunchDialog
        key={`connection-launch-${activeSessionTab?.clientId ?? "closed"}`}
        connectionName={activeSessionTab?.name ?? ""}
        endpoint={activeSessionTab?.endpoint ?? ""}
        errorMessage={
          connectionState === "failed" ? (errorMessage ?? undefined) : undefined
        }
        hostKey={hostKey ?? undefined}
        pending={connectionState === "connecting"}
        step={activeSessionTab ? connectionLaunchStep : undefined}
        onCancel={cancelConnectionFlow}
        onConfirmFingerprint={confirmConnectionFingerprint}
        onSubmitPassword={(credential) =>
          void authenticatePendingConnection(credential)
        }
      />

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

function connectionAuthLabel(method: AuthMethod, t: TFunction): string {
  switch (method) {
    case "privateKey":
      return t("connectionEditor.auth.privateKey");
    case "keyboardInteractive":
      return t("connectionEditor.auth.keyboardInteractive");
    default:
      return t("connectionEditor.auth.password");
  }
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
