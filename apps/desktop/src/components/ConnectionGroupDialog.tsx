import { useId, useState } from "react";
import { Button, Input } from "antd";
import { Eraser } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConnectionGroup } from "../ipc/bindings";
import { AppDialog, FeedbackNotice } from "./Feedback";

interface ConnectionGroupDialogProps {
  errorMessage?: string;
  initialValue?: ConnectionGroup;
  open: boolean;
  pending?: boolean;
  onClose(): void;
  onSubmit(group: ConnectionGroup): void;
}

export function ConnectionGroupDialog({
  errorMessage,
  initialValue,
  open,
  pending = false,
  onClose,
  onSubmit,
}: ConnectionGroupDialogProps) {
  const { t } = useTranslation();
  const generatedId = useId().replaceAll(":", "");
  const [draftId] = useState(
    () => initialValue?.id ?? createConnectionGroupId(),
  );
  const [name, setName] = useState(initialValue?.name ?? "");
  const [color, setColor] = useState(initialValue?.color ?? "");
  const [nameError, setNameError] = useState(false);
  const [colorError, setColorError] = useState(false);

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(true);
      return;
    }
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      setColorError(true);
      return;
    }
    onSubmit({
      id: draftId,
      name: trimmedName,
      color: color || null,
      sortOrder: initialValue?.sortOrder ?? 0,
      isCollapsed: initialValue?.isCollapsed ?? false,
      revision: initialValue?.revision ?? 1,
    });
  };

  return (
    <AppDialog
      open={open}
      title={
        initialValue
          ? t("connectionGroup.titleEdit")
          : t("connectionGroup.titleNew")
      }
      closable={!pending}
      closeOnEscape={!pending}
      maskClosable={false}
      onClose={onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={pending} type="primary" onClick={submit}>
            {t("common.confirm")}
          </Button>
        </>
      }
    >
      <div className="connection-group-form">
        <label className="field-group" htmlFor={`${generatedId}-name`}>
          <span className="field-label">{t("connectionGroup.name")}</span>
          <Input
            id={`${generatedId}-name`}
            aria-invalid={nameError}
            autoFocus
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(false);
            }}
            onPressEnter={submit}
          />
          {nameError && (
            <span className="field-error">
              {t("connectionEditor.validation.required")}
            </span>
          )}
        </label>
        <label className="field-group" htmlFor={`${generatedId}-color`}>
          <span className="field-label">{t("connectionGroup.color")}</span>
          <div className="connection-color-control">
            <input
              id={`${generatedId}-color`}
              aria-label={t("connectionGroup.color")}
              className="connection-color-swatch"
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#1677ff"}
              onChange={(event) => {
                setColor(event.target.value);
                setColorError(false);
              }}
            />
            <Input
              aria-label={t("connectionGroup.colorValue")}
              value={color}
              placeholder="#1677FF"
              onChange={(event) => {
                const value = event.target.value;
                if (value === "" || /^#[0-9a-fA-F]{0,6}$/.test(value)) {
                  setColor(value);
                  setColorError(false);
                }
              }}
            />
            <Button
              aria-label={t("connectionGroup.clearColor")}
              icon={<Eraser size={14} />}
              disabled={!color}
              onClick={() => {
                setColor("");
                setColorError(false);
              }}
            />
          </div>
          {colorError && (
            <span className="field-error">
              {t("connectionEditor.validation.color")}
            </span>
          )}
        </label>
        {errorMessage && (
          <FeedbackNotice
            type="error"
            showIcon
            message={t("connectionGroup.saveFailed")}
            description={errorMessage}
          />
        )}
      </div>
    </AppDialog>
  );
}

function createConnectionGroupId(): string {
  return `group-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}
