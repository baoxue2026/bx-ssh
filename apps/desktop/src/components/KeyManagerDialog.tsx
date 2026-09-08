import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Button, Input, Radio, Space, Tag } from "antd";
import { Key, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PrivateKeyStorageKind, PrivateKeySummary } from "../ipc/bindings";
import { ipc } from "../ipc/client";
import { AppDialog, FeedbackNotice, LoadingState } from "./Feedback";

interface KeyManagerDialogProps {
  open: boolean;
  onClose(): void;
}

export function KeyManagerDialog({ open, onClose }: KeyManagerDialogProps) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<PrivateKeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [storageKind, setStorageKind] = useState<PrivateKeyStorageKind>("file");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setKeys(await ipc.listPrivateKeys());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("keyManager.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, open]);

  const chooseFile = async () => {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: t("keyManager.chooseFile"),
    });
    if (typeof selected === "string") {
      setPath(selected);
      if (!name) {
        const fileName = selected.split(/[\\/]/).pop() ?? "";
        setName(fileName || t("keyManager.defaultName"));
      }
      setError(undefined);
    }
  };

  const addKey = async () => {
    if (!path.trim() || !name.trim()) {
      setError(t("keyManager.required"));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await ipc.savePrivateKeyReference(
        {
          name: name.trim(),
          storageKind,
          filePath: path.trim(),
          comment: comment.trim() || null,
        },
        passphrase || null,
      );
      setPath("");
      setName("");
      setComment("");
      setPassphrase("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("keyManager.saveFailed"),
      );
    } finally {
      setPending(false);
    }
  };

  const removeKey = async (item: PrivateKeySummary) => {
    if (item.referenceCount > 0) return;
    setPending(true);
    setError(undefined);
    try {
      await ipc.deletePrivateKeyReference(item.id);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("keyManager.deleteFailed"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <AppDialog
      className="key-manager-dialog"
      open={open}
      title={t("keyManager.title")}
      closable={!pending}
      closeOnEscape={!pending}
      onClose={onClose}
      footer={
        <Button disabled={pending} onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      {error && (
        <FeedbackNotice
          type="error"
          showIcon
          message={t("keyManager.error")}
          description={error}
        />
      )}
      <section className="key-manager-list" aria-label={t("keyManager.list")}>
        {loading ? (
          <LoadingState label={t("keyManager.loading")} />
        ) : keys.length === 0 ? (
          <p className="key-manager-empty">{t("keyManager.empty")}</p>
        ) : (
          keys.map((item) => (
            <div className="key-manager-item" key={item.id}>
              <div className="key-manager-item-main">
                <Key size={15} />
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.publicKeyAlgorithm ?? "SSH"} ·{" "}
                    {item.fingerprintSha256 ?? "-"}
                  </span>
                  <span>
                    {item.storageKind === "file"
                      ? item.filePath
                      : t("keyManager.imported")}{" "}
                    ·{" "}
                    {t("keyManager.references", { count: item.referenceCount })}
                  </span>
                </div>
              </div>
              <Space>
                <Tag color={item.storageKind === "file" ? "blue" : "green"}>
                  {item.storageKind === "file"
                    ? t("keyManager.file")
                    : t("keyManager.imported")}
                </Tag>
                <Button
                  aria-label={t("keyManager.delete")}
                  danger
                  disabled={pending || item.referenceCount > 0}
                  icon={<Trash2 size={14} />}
                  onClick={() => void removeKey(item)}
                />
              </Space>
            </div>
          ))
        )}
      </section>
      <section className="key-manager-form">
        <h4>{t("keyManager.addTitle")}</h4>
        <Space.Compact block>
          <Input
            value={path}
            readOnly
            placeholder={t("keyManager.filePlaceholder")}
          />
          <Button icon={<Plus size={14} />} onClick={() => void chooseFile()}>
            {t("keyManager.choose")}
          </Button>
        </Space.Compact>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("keyManager.namePlaceholder")}
        />
        <Input
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t("keyManager.commentPlaceholder")}
        />
        <Radio.Group
          value={storageKind}
          onChange={(event) => setStorageKind(event.target.value)}
        >
          <Radio value="file">{t("keyManager.fileReference")}</Radio>
          <Radio value="imported">{t("keyManager.encryptedImport")}</Radio>
        </Radio.Group>
        <Input.Password
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder={t("keyManager.passphrasePlaceholder")}
        />
        <Button
          type="primary"
          loading={pending}
          disabled={!path || !name}
          onClick={() => void addKey()}
        >
          {t("keyManager.add")}
        </Button>
      </section>
    </AppDialog>
  );
}
