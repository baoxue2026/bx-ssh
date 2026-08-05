import { useEffect, useRef, useState } from "react";
import { Button, Input, Radio } from "antd";
import { Fingerprint, KeyRound, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { HostKeyInfo } from "../ipc/bindings";
import { AppDialog, FeedbackNotice } from "./Feedback";
import type { CredentialMode } from "./ConnectionEditorDialog";

export type ConnectionLaunchStep = "fingerprint" | "password";

interface ConnectionLaunchDialogProps {
  connectionName: string;
  endpoint: string;
  errorMessage?: string;
  hostKey?: HostKeyInfo;
  initialPassword?: string;
  pending: boolean;
  step?: ConnectionLaunchStep;
  onCancel(): void;
  onConfirmFingerprint(): void;
  onSubmitPassword(password: string, mode: CredentialMode): void;
  initialCredentialMode?: CredentialMode;
}

export function ConnectionLaunchDialog({
  connectionName,
  endpoint,
  errorMessage,
  hostKey,
  initialPassword,
  pending,
  step,
  onCancel,
  onConfirmFingerprint,
  onSubmitPassword,
  initialCredentialMode = "ask",
}: ConnectionLaunchDialogProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [password, setPassword] = useState(initialPassword ?? "");
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(
    initialCredentialMode,
  );
  const passwordStep = step === "password";

  useEffect(() => {
    if (passwordStep) {
      setPassword(initialPassword ?? "");
    }
  }, [initialPassword, passwordStep]);

  const submitPassword = () => {
    if (!password || pending) return;
    const credential = password;
    setPassword("");
    onSubmitPassword(credential, credentialMode);
  };

  const cancel = () => {
    setPassword("");
    onCancel();
  };

  return (
    <AppDialog
      className="connection-launch-dialog"
      width={passwordStep ? 420 : 500}
      open={step !== undefined}
      title={
        passwordStep
          ? t("connectionAuthentication.title")
          : t("hostFingerprint.title")
      }
      description={
        passwordStep
          ? t("connectionAuthentication.description", {
              name: connectionName,
            })
          : t("hostFingerprint.description", { name: connectionName })
      }
      initialFocusRef={passwordStep ? undefined : cancelRef}
      closable
      closeOnEscape
      onClose={cancel}
      footer={
        <>
          <Button ref={cancelRef} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          {passwordStep ? (
            <Button
              type="primary"
              loading={pending}
              disabled={!password}
              onClick={submitPassword}
            >
              {t("connectionAuthentication.connect")}
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!hostKey || pending}
              loading={pending}
              onClick={onConfirmFingerprint}
            >
              {t("hostFingerprint.trustAndContinue")}
            </Button>
          )}
        </>
      }
    >
      {passwordStep ? (
        <>
          <div className="connection-auth-endpoint">
            <KeyRound size={16} aria-hidden="true" />
            <span>{endpoint}</span>
          </div>
          <label className="field-group">
            <span className="field-label">
              {t("connectionAuthentication.password")}
            </span>
            <Input.Password
              autoFocus
              value={password}
              autoComplete="current-password"
              disabled={pending}
              onChange={(event) => setPassword(event.target.value)}
              onPressEnter={submitPassword}
            />
          </label>
          <fieldset className="field-group connection-credential-mode">
            <legend className="field-label">
              {t("connectionAuthentication.credentialMode")}
            </legend>
            <Radio.Group
              aria-label={t("connectionAuthentication.credentialMode")}
              buttonStyle="solid"
              value={credentialMode}
              onChange={(event) => {
                const nextMode = event.target.value as CredentialMode;
                setCredentialMode(nextMode);
                if (nextMode === "ask") {
                  setPassword("");
                }
              }}
            >
              {(["ask", "session", "vault"] as CredentialMode[]).map((mode) => (
                <Radio.Button key={mode} value={mode} disabled={pending}>
                  {t(`connectionAuthentication.modes.${mode}`)}
                </Radio.Button>
              ))}
            </Radio.Group>
          </fieldset>
          {errorMessage && (
            <FeedbackNotice
              type="error"
              showIcon
              message={t("connectionAuthentication.failed")}
              description={errorMessage}
            />
          )}
          <p className="connection-auth-hint">
            {t("connectionAuthentication.sessionOnly")}
          </p>
        </>
      ) : (
        <>
          <div className="host-fingerprint-endpoint">
            <Server size={16} aria-hidden="true" />
            <span>{endpoint}</span>
          </div>
          <div className="host-fingerprint-value">
            <span>
              <Fingerprint size={15} aria-hidden="true" />
              {hostKey?.algorithm ?? t("hostFingerprint.unknownAlgorithm")}
            </span>
            <code>{hostKey?.fingerprintSha256}</code>
          </div>
          <p className="host-fingerprint-warning">
            {t("hostFingerprint.warning")}
          </p>
        </>
      )}
    </AppDialog>
  );
}
