import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Progress, Tooltip } from "antd";
import type { TFunction } from "i18next";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppDialog, FeedbackNotice } from "./Feedback";
import { ipc } from "../ipc/client";
import type { UpdateInfo } from "../ipc/bindings";
import { useAsyncAction } from "./useAsyncAction";

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
  requestId?: number;
}

export function UpdateControl({
  currentVersion,
  requestId = 0,
}: UpdateControlProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const handledRequestId = useRef(0);
  const checkButtonRef = useRef<HTMLButtonElement>(null);
  const dialogDescriptionId = useId();

  const progress = useMemo(() => {
    if (!totalBytes || totalBytes <= 0) return 0;
    return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  }, [downloadedBytes, totalBytes]);

  const checkForUpdate = useCallback(async () => {
    setStatus("checking");
    setErrorMessage(null);
    try {
      const available = await ipc.checkForUpdate();
      setUpdate(available ?? null);
      setStatus(available ? "available" : "current");
      setOpen(true);
    } catch (error) {
      setErrorMessage(errorText(error, t("update.serviceUnavailable")));
      setStatus("error");
      setOpen(true);
    }
  }, [t]);
  const { execute: runCheckForUpdate, pending: checkPending } =
    useAsyncAction(checkForUpdate);

  useEffect(() => {
    if (requestId <= handledRequestId.current) return;
    handledRequestId.current = requestId;
    void runCheckForUpdate();
  }, [requestId, runCheckForUpdate]);

  const installUpdate = useCallback(async () => {
    if (!update) return;

    setStatus("downloading");
    setDownloadedBytes(0);
    setTotalBytes(null);
    setErrorMessage(null);

    try {
      await ipc.installUpdate(update.version, (event) => {
        if (event.type === "started") {
          setTotalBytes(event.contentLength);
        } else if (event.type === "progress") {
          setDownloadedBytes((current) => current + event.chunkLength);
        } else {
          setStatus("verified");
        }
      });
    } catch (error) {
      setErrorMessage(errorText(error, t("update.serviceUnavailable")));
      setStatus("error");
    }
  }, [t, update]);
  const { execute: runInstallUpdate, pending: installPending } =
    useAsyncAction(installUpdate);

  const close = () => {
    if (status === "downloading" || status === "verified") return;
    setOpen(false);
  };

  return (
    <>
      <Tooltip title={t("update.checking")}>
        <Button
          className="update-trigger"
          ref={checkButtonRef}
          type="text"
          size="small"
          aria-label={t("update.checking")}
          icon={<RefreshCw size={14} />}
          loading={status === "checking" || checkPending}
          onClick={() => void runCheckForUpdate()}
        />
      </Tooltip>

      <AppDialog
        title={modalTitle(status, update, t)}
        open={open}
        width={440}
        closable={status !== "downloading" && status !== "verified"}
        closeOnEscape={status !== "downloading" && status !== "verified"}
        maskClosable={false}
        onClose={close}
        returnFocusRef={checkButtonRef}
        descriptionId={dialogDescriptionId}
        footer={
          status === "available"
            ? [
                <Button key="cancel" onClick={close}>
                  {t("update.later")}
                </Button>,
                <Button
                  key="install"
                  type="primary"
                  icon={<Download size={15} />}
                  loading={installPending}
                  onClick={() => void runInstallUpdate()}
                >
                  {t("update.downloadAndInstall")}
                </Button>,
              ]
            : status === "downloading" || status === "verified"
              ? null
              : [
                  <Button key="close" type="primary" onClick={close}>
                    {t("common.confirm")}
                  </Button>,
                ]
        }
      >
        <div id={dialogDescriptionId}>
          {status === "current" && (
            <p className="update-message">
              {t("update.current", { version: currentVersion })}
            </p>
          )}

          {status === "available" && update && (
            <div className="update-details">
              <div className="update-version-row">
                <span>
                  {t("update.currentVersion", {
                    version: update.currentVersion,
                  })}
                </span>
                <span>
                  {t("update.newVersion", { version: update.version })}
                </span>
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
              <span>{t("update.downloading")}</span>
            </div>
          )}

          {status === "verified" && (
            <div className="update-verified">
              <ShieldCheck size={20} />
              <span>{t("update.verified")}</span>
            </div>
          )}

          {status === "error" && errorMessage && (
            <FeedbackNotice
              type="error"
              showIcon
              message={t("update.error")}
              description={errorMessage}
            />
          )}
        </div>
      </AppDialog>
    </>
  );
}

function modalTitle(
  status: UpdateStatus,
  update: UpdateInfo | null,
  t: TFunction,
): string {
  if (status === "available" && update) {
    return t("update.availableTitle", { version: update.version });
  }
  if (status === "downloading") return t("update.downloadTitle");
  if (status === "verified") return t("update.installTitle");
  if (status === "error") return t("update.errorTitle");
  return t("update.versionTitle");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function errorText(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return fallback;
}
