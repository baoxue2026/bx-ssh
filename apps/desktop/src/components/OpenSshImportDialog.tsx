import { useMemo, useState } from "react";
import { Button, Checkbox, Radio, Tooltip } from "antd";
import { FileSearch, FolderOpen, KeyRound, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  OpenSshDuplicateStrategy,
  OpenSshImportError,
  OpenSshImportPreview,
  OpenSshImportRequest,
  OpenSshImportWarning,
} from "../ipc/bindings";
import {
  AppDialog,
  EmptyState,
  FeedbackNotice,
  LoadingState,
} from "./Feedback";

interface OpenSshImportDialogProps {
  errorMessage?: string;
  loading: boolean;
  open: boolean;
  pending: boolean;
  preview?: OpenSshImportPreview;
  onBrowse(): void;
  onClose(): void;
  onLoadDefault(): void;
  onSubmit(request: OpenSshImportRequest): void;
}

export function OpenSshImportDialog({
  errorMessage,
  loading,
  open,
  pending,
  preview,
  onBrowse,
  onClose,
  onLoadDefault,
  onSubmit,
}: OpenSshImportDialogProps) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<string[] | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] =
    useState<OpenSshDuplicateStrategy>("skip");
  const importableIds = useMemo(
    () =>
      preview?.items
        .filter((item) => item.errors.length === 0)
        .map((item) => item.sourceId) ?? [],
    [preview],
  );
  const selectedIds = selection ?? importableIds;
  const selectedDuplicates =
    preview?.items.filter(
      (item) =>
        selectedIds.includes(item.sourceId) &&
        item.duplicateConnectionId !== null,
    ).length ?? 0;

  const toggleAll = (checked: boolean) => {
    setSelection(checked ? importableIds : []);
  };

  const toggleItem = (sourceId: string, checked: boolean) => {
    setSelection(
      checked
        ? [...selectedIds, sourceId]
        : selectedIds.filter((id) => id !== sourceId),
    );
  };

  return (
    <AppDialog
      className="openssh-import-dialog"
      width={780}
      open={open}
      title={t("connectionImport.title")}
      description={t("connectionImport.description")}
      closable={!pending}
      closeOnEscape={!pending}
      onClose={onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="primary"
            loading={pending}
            disabled={loading || !preview || selectedIds.length === 0}
            onClick={() => {
              if (!preview) return;
              onSubmit({
                sourcePath: preview.sourcePath,
                sourceFingerprint: preview.sourceFingerprint,
                selectedSourceIds: selectedIds,
                duplicateStrategy,
              });
            }}
          >
            {t("connectionImport.importSelected", {
              count: selectedIds.length,
            })}
          </Button>
        </>
      }
    >
      <div className="openssh-import-source">
        <span
          className="openssh-import-source-path"
          title={preview?.sourcePath}
        >
          {preview?.sourcePath ?? t("connectionImport.noSource")}
        </span>
        <Tooltip title={t("connectionImport.loadDefaultHelp")}>
          <Button
            icon={<RefreshCw size={14} />}
            disabled={pending}
            loading={loading}
            onClick={onLoadDefault}
          >
            {t("connectionImport.loadDefault")}
          </Button>
        </Tooltip>
        <Button
          icon={<FolderOpen size={14} />}
          disabled={pending || loading}
          onClick={onBrowse}
        >
          {t("connectionImport.chooseFile")}
        </Button>
      </div>

      {errorMessage && (
        <FeedbackNotice
          className="openssh-import-error"
          type="error"
          showIcon
          message={t("connectionImport.loadFailed")}
          description={errorMessage}
        />
      )}

      {loading ? (
        <LoadingState label={t("connectionImport.loading")} />
      ) : preview ? (
        <>
          <div className="openssh-import-summary">
            <Checkbox
              checked={
                importableIds.length > 0 &&
                selectedIds.length === importableIds.length
              }
              indeterminate={
                selectedIds.length > 0 &&
                selectedIds.length < importableIds.length
              }
              disabled={pending || importableIds.length === 0}
              onChange={(event) => toggleAll(event.target.checked)}
            >
              {t("connectionImport.selectAll", {
                count: importableIds.length,
              })}
            </Checkbox>
            <span>
              {t("connectionImport.previewSummary", {
                count: preview.items.length,
                ignored: preview.ignoredHostPatterns,
              })}
            </span>
          </div>

          <div className="openssh-import-list" role="list">
            {preview.items.map((item) => {
              const importable = item.errors.length === 0;
              return (
                <article
                  className={`openssh-import-item${importable ? "" : " is-invalid"}`}
                  key={item.sourceId}
                  role="listitem"
                >
                  <Checkbox
                    aria-label={t("connectionImport.selectNamed", {
                      name: item.alias,
                    })}
                    checked={selectedIds.includes(item.sourceId)}
                    disabled={pending || !importable}
                    onChange={(event) =>
                      toggleItem(item.sourceId, event.target.checked)
                    }
                  />
                  <span className="openssh-import-item-main">
                    <strong>{item.alias}</strong>
                    <code>
                      {item.username || "—"}@{item.host || "—"}:{item.port}
                    </code>
                    {item.identityFile && (
                      <span className="openssh-import-identity">
                        <KeyRound size={12} />
                        <code title={item.identityFile}>
                          {item.identityFile}
                        </code>
                      </span>
                    )}
                  </span>
                  <span className="openssh-import-item-status">
                    {item.errors.map((error) => (
                      <span className="is-error" key={error}>
                        {importErrorLabel(error, t)}
                      </span>
                    ))}
                    {item.warnings.map((warning) => (
                      <span className="is-warning" key={warning}>
                        {importWarningLabel(
                          warning,
                          item.duplicateConnectionName,
                          t,
                        )}
                      </span>
                    ))}
                    {item.errors.length === 0 && item.warnings.length === 0 && (
                      <span className="is-ready">
                        {t("connectionImport.ready")}
                      </span>
                    )}
                  </span>
                </article>
              );
            })}
          </div>

          {preview.items.length === 0 && (
            <EmptyState
              className="openssh-import-empty"
              icon={<FileSearch size={28} strokeWidth={1.4} />}
              title={t("connectionImport.emptyTitle")}
              description={t("connectionImport.emptyDescription")}
            />
          )}

          {selectedDuplicates > 0 && (
            <div className="openssh-import-duplicates">
              <strong>
                {t("connectionImport.duplicates", {
                  count: selectedDuplicates,
                })}
              </strong>
              <Radio.Group
                value={duplicateStrategy}
                disabled={pending}
                onChange={(event) => setDuplicateStrategy(event.target.value)}
              >
                <Radio value="skip">
                  {t("connectionImport.duplicateSkip")}
                </Radio>
                <Radio value="overwrite">
                  {t("connectionImport.duplicateOverwrite")}
                </Radio>
              </Radio.Group>
            </div>
          )}

          {preview.items.some((item) => item.identityFile !== null) && (
            <FeedbackNotice
              className="openssh-import-key-notice"
              type="warning"
              showIcon
              message={t("connectionImport.identityTitle")}
              description={t("connectionImport.identityDescription")}
            />
          )}
        </>
      ) : (
        <EmptyState
          className="openssh-import-empty"
          icon={<FileSearch size={28} strokeWidth={1.4} />}
          title={t("connectionImport.noPreviewTitle")}
          description={t("connectionImport.noPreviewDescription")}
        />
      )}
    </AppDialog>
  );
}

function importErrorLabel(
  error: OpenSshImportError,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return t(`connectionImport.errors.${error}`);
}

function importWarningLabel(
  warning: OpenSshImportWarning,
  duplicateName: string | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return t(`connectionImport.warnings.${warning}`, {
    name: duplicateName ?? "",
  });
}
