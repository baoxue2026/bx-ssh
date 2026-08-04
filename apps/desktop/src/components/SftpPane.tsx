import { useState } from "react";
import { Button, Input, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  CheckCircle2,
  Download,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Upload,
} from "lucide-react";
import type { RemoteDirectoryListing, TransferSummary } from "../ipc/bindings";
import { EmptyState, LoadingState } from "./Feedback";

export interface SftpTransferResult {
  direction: "upload" | "download";
  summary: TransferSummary;
}

interface SftpPaneProps {
  busy: boolean;
  connected: boolean;
  directory: RemoteDirectoryListing | null;
  endpoint: string;
  transferResult: SftpTransferResult | null;
  onDownload(remotePath: string, localPath: string): Promise<void>;
  onNavigate(path: string): Promise<void>;
  onRefresh(): Promise<void>;
  onUpload(localPath: string, remotePath: string): Promise<void>;
}

export function SftpPane({
  busy,
  connected,
  directory,
  endpoint,
  transferResult,
  onDownload,
  onNavigate,
  onRefresh,
  onUpload,
}: SftpPaneProps) {
  const { i18n, t } = useTranslation();
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [localUploadPath, setLocalUploadPath] = useState("");
  const [remoteUploadPath, setRemoteUploadPath] = useState("");
  const [remoteDownloadPath, setRemoteDownloadPath] = useState("");
  const [localDownloadPath, setLocalDownloadPath] = useState("");

  const pathInput = pathDraft ?? directory?.path ?? ".";
  const parentPath = directory ? remoteParentPath(directory.path) : ".";
  const navigate = async (path: string) => {
    setPathDraft(null);
    await onNavigate(path);
  };

  return (
    <section className="sftp-pane" aria-label={t("sftp.aria")}>
      <div className="sftp-toolbar">
        <div className="sftp-path-controls">
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
              onClick={() => void onRefresh()}
            />
          </Tooltip>
        </div>
        <span className="endpoint-label">
          {connected ? endpoint : t("sftp.notConnected")}
        </span>
      </div>

      <div className="sftp-list" aria-busy={busy}>
        <table>
          <thead>
            <tr>
              <th>{t("sftp.name")}</th>
              <th>{t("sftp.size")}</th>
              <th>{t("sftp.modified")}</th>
              <th>{t("sftp.permissions")}</th>
            </tr>
          </thead>
          <tbody>
            {directory?.entries.map((entry) => (
              <tr
                key={entry.path}
                tabIndex={0}
                onClick={() => {
                  if (entry.kind === "file") {
                    setRemoteDownloadPath(entry.path);
                  }
                }}
                onDoubleClick={() => {
                  if (entry.kind === "directory") {
                    void navigate(entry.path);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    if (entry.kind === "directory") {
                      void navigate(entry.path);
                    } else if (entry.kind === "file") {
                      setRemoteDownloadPath(entry.path);
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
                  {entry.kind === "directory" ? "" : formatBytes(entry.size)}
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

        {connected && directory?.entries.length === 0 && (
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
            <code>{transferResult.summary.sha256}</code>
          </div>
        )}
      </div>
    </section>
  );
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
