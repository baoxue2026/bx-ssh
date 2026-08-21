import { useMemo, useState } from "react";
import { Button, Input, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpAZ,
  ArrowUpWideNarrow,
  CheckCircle2,
  Download,
  Eye,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Upload,
} from "lucide-react";
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  RemoteDirectoryListing,
  RemoteFileEntry,
  TransferBatchSummary,
  TransferSummary,
} from "../ipc/bindings";
import { EmptyState, LoadingState } from "./Feedback";

export interface SftpTransferResult {
  direction: "upload" | "download";
  summary: TransferSummary | TransferBatchSummary;
}

interface SftpPaneProps {
  busy: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  connected: boolean;
  directory: RemoteDirectoryListing | null;
  endpoint: string;
  localBusy: boolean;
  localDirectory: LocalDirectoryListing | null;
  transferResult: SftpTransferResult | null;
  transferId: string | null;
  onDownload(remotePath: string, localPath: string): Promise<void>;
  onBack(): Promise<void>;
  onForward(): Promise<void>;
  onLocalNavigate(path: string): Promise<void>;
  onLocalRefresh(): Promise<void>;
  onNavigate(path: string): Promise<void>;
  onRefresh(): Promise<void>;
  onUpload(localPath: string, remotePath: string): Promise<void>;
  onCancelTransfer(): Promise<void>;
}

export function SftpPane({
  busy,
  canGoBack,
  canGoForward,
  connected,
  directory,
  endpoint,
  localBusy,
  localDirectory,
  transferResult,
  transferId,
  onDownload,
  onBack,
  onForward,
  onLocalNavigate,
  onLocalRefresh,
  onNavigate,
  onRefresh,
  onUpload,
  onCancelTransfer,
}: SftpPaneProps) {
  const { i18n, t } = useTranslation();
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [localPathDraft, setLocalPathDraft] = useState<string | null>(null);
  const [localUploadPath, setLocalUploadPath] = useState("");
  const [remoteUploadPath, setRemoteUploadPath] = useState("");
  const [remoteDownloadPath, setRemoteDownloadPath] = useState("");
  const [localDownloadPath, setLocalDownloadPath] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [localSort, setLocalSort] = useState<SortState>(defaultSortState);
  const [remoteSort, setRemoteSort] = useState<SortState>(defaultSortState);
  const [selectedLocalPath, setSelectedLocalPath] = useState<string | null>(
    null,
  );
  const [selectedRemotePath, setSelectedRemotePath] = useState<string | null>(
    null,
  );

  const pathInput = pathDraft ?? directory?.path ?? ".";
  const parentPath = directory ? remoteParentPath(directory.path) : ".";
  const localPathInput = localPathDraft ?? localDirectory?.path ?? ".";
  const visibleLocalEntries = useMemo(
    () =>
      sortEntries(
        localDirectory?.entries.filter(
          (entry) => showHidden || !entry.hidden,
        ) ?? [],
        localSort,
      ),
    [localDirectory?.entries, localSort, showHidden],
  );
  const visibleRemoteEntries = useMemo(
    () =>
      sortEntries(
        directory?.entries.filter(
          (entry) => showHidden || !entry.name.startsWith("."),
        ) ?? [],
        remoteSort,
      ),
    [directory?.entries, remoteSort, showHidden],
  );

  const navigate = async (path: string) => {
    setPathDraft(null);
    setSelectedRemotePath(null);
    await onNavigate(path);
  };

  const navigateLocal = async (path: string) => {
    setLocalPathDraft(null);
    setSelectedLocalPath(null);
    await onLocalNavigate(path);
  };

  const selectLocalEntry = (entry: LocalFileEntry) => {
    setSelectedLocalPath(entry.path);
    if (entry.kind === "file" || entry.kind === "directory") {
      setLocalUploadPath(entry.path);
      setRemoteUploadPath(joinRemotePath(directory?.path ?? ".", entry.name));
    }
  };

  const selectRemoteEntry = (entry: RemoteFileEntry) => {
    setSelectedRemotePath(entry.path);
    if (entry.kind === "file" || entry.kind === "directory") {
      setRemoteDownloadPath(entry.path);
      setLocalDownloadPath(
        joinLocalPath(localDirectory?.path ?? ".", entry.name),
      );
    }
  };

  return (
    <section className="sftp-pane" aria-label={t("sftp.aria")}>
      <div className="sftp-toolbar">
        <div className="sftp-path-controls">
          <Tooltip title={t("sftp.back")}>
            <Button
              aria-label={t("sftp.back")}
              icon={<ArrowLeft size={15} />}
              disabled={!connected || busy || !canGoBack}
              onClick={() => {
                setSelectedRemotePath(null);
                void onBack();
              }}
            />
          </Tooltip>
          <Tooltip title={t("sftp.forward")}>
            <Button
              aria-label={t("sftp.forward")}
              icon={<ArrowRight size={15} />}
              disabled={!connected || busy || !canGoForward}
              onClick={() => {
                setSelectedRemotePath(null);
                void onForward();
              }}
            />
          </Tooltip>
          <Tooltip title={t("sftp.parentDirectory")}>
            <Button
              aria-label={t("sftp.parentDirectory")}
              icon={<ArrowUp size={15} />}
              disabled={!connected || busy}
              onClick={() => void navigate(parentPath)}
            />
          </Tooltip>
          <Input
            aria-label={t("sftp.path")}
            value={pathInput}
            disabled={!connected || busy}
            onChange={(event) => setPathDraft(event.target.value)}
            onPressEnter={() => void navigate(pathInput)}
          />
          <Tooltip title={t("sftp.refresh")}>
            <Button
              aria-label={t("sftp.refresh")}
              icon={<RefreshCw size={15} />}
              loading={busy}
              disabled={!connected}
              onClick={() => {
                setSelectedRemotePath(null);
                void onRefresh();
              }}
            />
          </Tooltip>
          <Tooltip title={t("sftp.showHidden")}>
            <Button
              aria-label={t("sftp.showHidden")}
              icon={<Eye size={15} />}
              type={showHidden ? "primary" : "default"}
              disabled={busy}
              onClick={() => setShowHidden((current) => !current)}
            />
          </Tooltip>
        </div>
        <span className="endpoint-label">
          {connected ? endpoint : t("sftp.notConnected")}
        </span>
      </div>

      <div className="sftp-browser-grid">
        <section
          className="sftp-file-panel sftp-local-panel"
          aria-label={t("sftp.localPanel")}
        >
          <div className="sftp-panel-toolbar">
            <strong>{t("sftp.local")}</strong>
            <div className="sftp-local-path-controls">
              <Tooltip title={t("sftp.localParentDirectory")}>
                <Button
                  aria-label={t("sftp.localParentDirectory")}
                  icon={<ArrowUp size={15} />}
                  disabled={localBusy || !localDirectory?.parentPath}
                  onClick={() =>
                    void navigateLocal(localDirectory?.parentPath ?? ".")
                  }
                />
              </Tooltip>
              <Input
                aria-label={t("sftp.localPath")}
                value={localPathInput}
                disabled={localBusy}
                onChange={(event) => setLocalPathDraft(event.target.value)}
                onPressEnter={(event) =>
                  void navigateLocal(event.currentTarget.value)
                }
              />
              <Tooltip title={t("sftp.localRefresh")}>
                <Button
                  aria-label={t("sftp.localRefresh")}
                  icon={<RefreshCw size={15} />}
                  loading={localBusy}
                  disabled={localBusy}
                  onClick={() => {
                    setSelectedLocalPath(null);
                    void onLocalRefresh();
                  }}
                />
              </Tooltip>
            </div>
          </div>
          <div className="sftp-list" aria-busy={localBusy}>
            <table>
              <thead>
                <tr>
                  <SortableHeader
                    label={t("sftp.name")}
                    sort={localSort}
                    sortKey="name"
                    onSort={(key) => setLocalSort(nextSort(localSort, key))}
                  />
                  <SortableHeader
                    label={t("sftp.size")}
                    sort={localSort}
                    sortKey="size"
                    onSort={(key) => setLocalSort(nextSort(localSort, key))}
                  />
                  <SortableHeader
                    label={t("sftp.modified")}
                    sort={localSort}
                    sortKey="modifiedAt"
                    onSort={(key) => setLocalSort(nextSort(localSort, key))}
                  />
                  <th>{t("sftp.permissions")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLocalEntries.map((entry) => (
                  <tr
                    key={entry.path}
                    aria-selected={selectedLocalPath === entry.path}
                    className={
                      selectedLocalPath === entry.path
                        ? "sftp-entry-selected"
                        : undefined
                    }
                    tabIndex={0}
                    onClick={() => selectLocalEntry(entry)}
                    onDoubleClick={() => {
                      if (entry.kind === "directory") {
                        void navigateLocal(entry.path);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (entry.kind === "directory") {
                          void navigateLocal(entry.path);
                        } else {
                          selectLocalEntry(entry);
                        }
                      }
                    }}
                  >
                    <td>
                      <span className="sftp-file-name">
                        {entry.kind === "directory" ? (
                          <Folder size={15} />
                        ) : (
                          <File size={15} />
                        )}
                        <span>{entry.name}</span>
                      </span>
                    </td>
                    <td>
                      {entry.kind === "directory"
                        ? ""
                        : formatBytes(entry.size)}
                    </td>
                    <td>
                      {formatModifiedTime(
                        entry.modifiedAt,
                        i18n.resolvedLanguage ?? "zh-CN",
                      )}
                    </td>
                    <td>{entry.readonly ? t("sftp.readOnly") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!localDirectory && !localBusy && (
              <EmptyState
                className="sftp-empty"
                icon={<FolderOpen size={34} strokeWidth={1.3} />}
                title={t("sftp.localNotLoaded")}
              />
            )}
            {localDirectory && visibleLocalEntries.length === 0 && (
              <EmptyState
                className="sftp-empty"
                icon={<FolderOpen size={34} strokeWidth={1.3} />}
                title={t("sftp.empty")}
              />
            )}
            {localBusy && (
              <LoadingState
                className="sftp-loading-overlay"
                label={t("feedback.loading")}
              />
            )}
          </div>
        </section>

        <section
          className="sftp-file-panel sftp-remote-panel"
          aria-label={t("sftp.remotePanel")}
        >
          <div className="sftp-panel-toolbar">
            <strong>{t("sftp.remote")}</strong>
            <span className="sftp-panel-path">{pathInput}</span>
          </div>
          <div className="sftp-list" aria-busy={busy}>
            <table>
              <thead>
                <tr>
                  <SortableHeader
                    label={t("sftp.name")}
                    sort={remoteSort}
                    sortKey="name"
                    onSort={(key) => setRemoteSort(nextSort(remoteSort, key))}
                  />
                  <SortableHeader
                    label={t("sftp.size")}
                    sort={remoteSort}
                    sortKey="size"
                    onSort={(key) => setRemoteSort(nextSort(remoteSort, key))}
                  />
                  <SortableHeader
                    label={t("sftp.modified")}
                    sort={remoteSort}
                    sortKey="modifiedAt"
                    onSort={(key) => setRemoteSort(nextSort(remoteSort, key))}
                  />
                  <th>{t("sftp.permissions")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRemoteEntries.map((entry) => (
                  <tr
                    key={entry.path}
                    aria-selected={selectedRemotePath === entry.path}
                    className={
                      selectedRemotePath === entry.path
                        ? "sftp-entry-selected"
                        : undefined
                    }
                    tabIndex={0}
                    onClick={() => selectRemoteEntry(entry)}
                    onDoubleClick={() => {
                      if (entry.kind === "directory") {
                        void navigate(entry.path);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (entry.kind === "directory") {
                          void navigate(entry.path);
                        } else {
                          selectRemoteEntry(entry);
                        }
                      }
                    }}
                  >
                    <td>
                      <span className="sftp-file-name">
                        {entry.kind === "directory" ? (
                          <Folder size={15} />
                        ) : (
                          <File size={15} />
                        )}
                        <span>{entry.name}</span>
                      </span>
                    </td>
                    <td>
                      {entry.kind === "directory"
                        ? ""
                        : formatBytes(entry.size)}
                    </td>
                    <td>
                      {formatModifiedTime(
                        entry.modifiedAt,
                        i18n.resolvedLanguage ?? "zh-CN",
                      )}
                    </td>
                    <td>{formatPermissions(entry.permissions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {connected && directory && visibleRemoteEntries.length === 0 && (
              <EmptyState
                className="sftp-empty"
                icon={<FolderOpen size={34} strokeWidth={1.3} />}
                title={t("sftp.empty")}
              />
            )}
            {!connected && (
              <EmptyState
                className="sftp-empty"
                icon={<FolderOpen size={34} strokeWidth={1.3} />}
                title={t("sftp.notConnected")}
              />
            )}
            {busy && (
              <LoadingState
                className="sftp-loading-overlay"
                label={t("feedback.loading")}
              />
            )}
          </div>
        </section>
      </div>

      <div className="sftp-transfer-panel">
        <div className="sftp-transfer-row">
          <Upload size={15} />
          <Input
            aria-label={t("sftp.uploadLocalLabel")}
            placeholder={t("sftp.uploadLocalPlaceholder")}
            value={localUploadPath}
            disabled={!connected || busy}
            onChange={(event) => setLocalUploadPath(event.target.value)}
          />
          <Input
            aria-label={t("sftp.uploadRemoteLabel")}
            placeholder={t("sftp.uploadRemotePlaceholder")}
            value={remoteUploadPath}
            disabled={!connected || busy}
            onChange={(event) => setRemoteUploadPath(event.target.value)}
          />
          <Button
            icon={<Upload size={14} />}
            loading={busy}
            disabled={!connected || !localUploadPath || !remoteUploadPath}
            onClick={() => void onUpload(localUploadPath, remoteUploadPath)}
          >
            {t("common.upload")}
          </Button>
        </div>

        <div className="sftp-transfer-row">
          <Download size={15} />
          <Input
            aria-label={t("sftp.downloadRemoteLabel")}
            placeholder={t("sftp.downloadRemotePlaceholder")}
            value={remoteDownloadPath}
            disabled={!connected || busy}
            onChange={(event) => setRemoteDownloadPath(event.target.value)}
          />
          <Input
            aria-label={t("sftp.downloadLocalLabel")}
            placeholder={t("sftp.downloadLocalPlaceholder")}
            value={localDownloadPath}
            disabled={!connected || busy}
            onChange={(event) => setLocalDownloadPath(event.target.value)}
          />
          <Button
            icon={<Download size={14} />}
            loading={busy}
            disabled={!connected || !remoteDownloadPath || !localDownloadPath}
            onClick={() =>
              void onDownload(remoteDownloadPath, localDownloadPath)
            }
          >
            {t("common.download")}
          </Button>
        </div>

        {transferId && (
          <div
            className="sftp-transfer-active"
            role="status"
            aria-live="polite"
          >
            <span>{t("sftp.directoryTransferActive")}</span>
            <Button size="small" danger onClick={() => void onCancelTransfer()}>
              {t("common.cancel")}
            </Button>
          </div>
        )}

        {transferResult && (
          <div
            className="sftp-transfer-result"
            role="status"
            aria-live="polite"
          >
            <CheckCircle2 size={15} />
            <span>
              {transferResult.direction === "upload"
                ? t("common.upload")
                : t("common.download")}
            </span>
            <strong>{formatBytes(transferResult.summary.bytes)}</strong>
            <span>{formatBytes(transferResult.summary.bytesPerSecond)}/s</span>
            {"sha256" in transferResult.summary ? (
              <code>{transferResult.summary.sha256}</code>
            ) : (
              <span>
                {t("sftp.batchTransferSummary", {
                  files: transferResult.summary.files,
                  directories: transferResult.summary.directories,
                })}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

type SortKey = "name" | "size" | "modifiedAt";
type SortDirection = "asc" | "desc";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

const defaultSortState: SortState = {
  key: "name",
  direction: "asc",
};

interface SortableEntry {
  kind: "directory" | "file" | "symlink" | "other";
  name: string;
  size: number;
  modifiedAt: number | null;
}

interface SortableHeaderProps {
  label: string;
  sort: SortState;
  sortKey: SortKey;
  onSort(key: SortKey): void;
}

function SortableHeader({ label, sort, sortKey, onSort }: SortableHeaderProps) {
  const active = sort.key === sortKey;
  const Icon = active
    ? sort.direction === "asc"
      ? sortKey === "name"
        ? ArrowDownAZ
        : ArrowDownWideNarrow
      : sortKey === "name"
        ? ArrowUpAZ
        : ArrowUpWideNarrow
    : null;
  return (
    <th
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className="sftp-sort-button"
        aria-label={label}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        {Icon && <Icon size={13} aria-hidden="true" />}
      </button>
    </th>
  );
}

function nextSort(current: SortState, key: SortKey): SortState {
  return current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "asc" };
}

function sortEntries<T extends SortableEntry>(
  entries: T[],
  sort: SortState,
): T[] {
  return [...entries].sort((left, right) => {
    const kindResult = fileKindOrder(left.kind) - fileKindOrder(right.kind);
    if (kindResult !== 0) {
      return kindResult;
    }
    let result: number;
    if (sort.key === "name") {
      result = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      });
    } else {
      result = (left[sort.key] ?? -1) - (right[sort.key] ?? -1);
    }
    return (
      (sort.direction === "asc" ? 1 : -1) *
      (result || left.name.localeCompare(right.name))
    );
  });
}

function fileKindOrder(kind: SortableEntry["kind"]): number {
  return kind === "directory"
    ? 0
    : kind === "file"
      ? 1
      : kind === "symlink"
        ? 2
        : 3;
}

function joinRemotePath(directory: string, name: string): string {
  if (directory === "." || directory === "") {
    return name;
  }
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

function joinLocalPath(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  if (directory === "." || directory === "") {
    return name;
  }
  return `${directory.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function remoteParentPath(path: string): string {
  if (path === "/") {
    return "/";
  }
  const normalized = path.replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatModifiedTime(seconds: number | null, language: string): string {
  if (seconds === null) {
    return "";
  }
  return new Intl.DateTimeFormat(language, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

function formatPermissions(permissions: number | null): string {
  return permissions === null ? "" : permissions.toString(8).padStart(4, "0");
}
