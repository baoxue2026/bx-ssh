import { useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Alert, Button, Modal, Progress, Tooltip } from "antd";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";

interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes: string | null;
  publishedAt: string | null;
}

type UpdateEvent =
  | { type: "started"; contentLength: number | null }
  | { type: "progress"; chunkLength: number }
  | { type: "verified" };

type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "verified"
  | "error";

interface UpdateControlProps {
  currentVersion: string;
}

export function UpdateControl({ currentVersion }: UpdateControlProps) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const progress = useMemo(() => {
    if (!totalBytes || totalBytes <= 0) return 0;
    return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  }, [downloadedBytes, totalBytes]);

  const checkForUpdate = async () => {
    setStatus("checking");
    setErrorMessage(null);
    try {
      const available = await invoke<UpdateInfo | null>("check_for_update");
      setUpdate(available ?? null);
      setStatus(available ? "available" : "current");
      setOpen(true);
    } catch (error) {
      setErrorMessage(errorText(error));
      setStatus("error");
      setOpen(true);
    }
  };

  const installUpdate = async () => {
    if (!update) return;

    setStatus("downloading");
    setDownloadedBytes(0);
    setTotalBytes(null);
    setErrorMessage(null);

    const eventChannel = new Channel<UpdateEvent>();
    eventChannel.onmessage = (event) => {
      if (event.type === "started") {
        setTotalBytes(event.contentLength);
      } else if (event.type === "progress") {
        setDownloadedBytes((current) => current + event.chunkLength);
      } else {
        setStatus("verified");
      }
    };

    try {
      await invoke("install_update", {
        expectedVersion: update.version,
        onEvent: eventChannel,
      });
    } catch (error) {
      setErrorMessage(errorText(error));
      setStatus("error");
    }
  };

  const close = () => {
    if (status === "downloading" || status === "verified") return;
    setOpen(false);
  };

  return (
    <>
      <Tooltip title="检查更新">
        <Button
          className="update-trigger"
          type="text"
          size="small"
          aria-label="检查更新"
          icon={<RefreshCw size={14} />}
          loading={status === "checking"}
          onClick={() => void checkForUpdate()}
        />
      </Tooltip>

      <Modal
        title={modalTitle(status, update)}
        open={open}
        width={440}
        closable={status !== "downloading" && status !== "verified"}
        maskClosable={false}
        onCancel={close}
        footer={
          status === "available"
            ? [
                <Button key="cancel" onClick={close}>
                  稍后
                </Button>,
                <Button
                  key="install"
                  type="primary"
                  icon={<Download size={15} />}
                  onClick={() => void installUpdate()}
                >
                  下载并安装
                </Button>,
              ]
            : status === "downloading" || status === "verified"
              ? null
              : [
                  <Button key="close" type="primary" onClick={close}>
                    确定
                  </Button>,
                ]
        }
      >
        {status === "current" && (
          <p className="update-message">
            当前版本 v{currentVersion} 已是最新版本。
          </p>
        )}

        {status === "available" && update && (
          <div className="update-details">
            <div className="update-version-row">
              <span>当前版本 v{update.currentVersion}</span>
              <span>新版本 v{update.version}</span>
            </div>
            {update.notes && <p>{update.notes}</p>}
          </div>
        )}

        {status === "downloading" && (
          <div className="update-progress">
            <Progress
              percent={progress}
              status="active"
              format={() =>
                totalBytes
                  ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                  : formatBytes(downloadedBytes)
              }
            />
            <span>正在下载并校验更新包</span>
          </div>
        )}

        {status === "verified" && (
          <div className="update-verified">
            <ShieldCheck size={20} />
            <span>签名验证通过，正在安装并重新启动。</span>
          </div>
        )}

        {status === "error" && errorMessage && (
          <Alert
            type="error"
            showIcon
            message="更新失败"
            description={errorMessage}
          />
        )}
      </Modal>
    </>
  );
}

function modalTitle(status: UpdateStatus, update: UpdateInfo | null): string {
  if (status === "available" && update) return `发现新版本 v${update.version}`;
  if (status === "downloading") return "下载更新";
  if (status === "verified") return "安装更新";
  if (status === "error") return "无法完成更新";
  return "版本更新";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown };
    if (typeof value.message === "string") return value.message;
  }
  return "更新服务暂时不可用";
}
