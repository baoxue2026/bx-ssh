import { useState } from "react";
import { Button, Input, Tooltip } from "antd";
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
    <section className="sftp-pane" aria-label="SFTP 文件验证">
      <div className="sftp-toolbar">
        <div className="sftp-path-controls">
          <Tooltip title="上级目录">
            <Button
              aria-label="上级目录"
              icon={<ArrowUp size={15} />}
              disabled={!connected || busy}
              onClick={() => void navigate(parentPath)}
            />
          </Tooltip>
          <Input
            aria-label="远端路径"
            value={pathInput}
            disabled={!connected || busy}
            onChange={(event) => setPathDraft(event.target.value)}
            onPressEnter={() => void navigate(pathInput)}
          />
          <Tooltip title="刷新目录">
            <Button
              aria-label="刷新目录"
              icon={<RefreshCw size={15} />}
              loading={busy}
              disabled={!connected}
              onClick={() => void onRefresh()}
            />
          </Tooltip>
        </div>
        <span className="endpoint-label">
          {connected ? endpoint : "未连接"}
        </span>
      </div>

      <div className="sftp-list" aria-busy={busy}>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>大小</th>
              <th>修改时间</th>
              <th>权限</th>
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
                <td>{formatModifiedTime(entry.modifiedAt)}</td>
                <td>{formatPermissions(entry.permissions)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {connected && directory?.entries.length === 0 && (
          <div className="sftp-empty">
            <FolderOpen size={34} strokeWidth={1.3} />
            <span>目录为空</span>
          </div>
        )}
        {!connected && (
          <div className="sftp-empty">
            <FolderOpen size={34} strokeWidth={1.3} />
            <span>未连接</span>
          </div>
        )}
      </div>

      <div className="sftp-transfer-panel">
        <div className="sftp-transfer-row">
          <Upload size={15} />
          <Input
            aria-label="上传本地源文件"
            placeholder="本地源文件路径"
            value={localUploadPath}
            disabled={!connected || busy}
            onChange={(event) => setLocalUploadPath(event.target.value)}
          />
          <Input
            aria-label="上传远端目标"
            placeholder="远端目标路径"
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
            上传
          </Button>
        </div>

        <div className="sftp-transfer-row">
          <Download size={15} />
          <Input
            aria-label="下载远端源文件"
            placeholder="远端源文件路径"
            value={remoteDownloadPath}
            disabled={!connected || busy}
            onChange={(event) => setRemoteDownloadPath(event.target.value)}
          />
          <Input
            aria-label="下载本地目标"
            placeholder="本地目标路径"
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
            下载
          </Button>
        </div>

        {transferResult && (
          <div className="sftp-transfer-result" role="status">
            <CheckCircle2 size={15} />
            <span>
              {transferResult.direction === "upload" ? "上传" : "下载"}
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

function formatModifiedTime(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

function formatPermissions(permissions: number | null): string {
  return permissions === null ? "" : permissions.toString(8).padStart(4, "0");
}
