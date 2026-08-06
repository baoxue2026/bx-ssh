import { useEffect, useRef, useState } from "react";
import { Button, Input, Radio } from "antd";
import { Fingerprint, KeyRound, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AuthMethod,
  HostKeyInfo,
  KeyboardInteractiveEvent,
} from "../ipc/bindings";
import { AppDialog, FeedbackNotice } from "./Feedback";
import type { CredentialMode } from "./ConnectionEditorDialog";

export type ConnectionLaunchStep =
  | "fingerprint"
  | "password"
  | "keyboardInteractive";

interface ConnectionLaunchDialogProps {
  connectionName: string;
  endpoint: string;
  errorMessage?: string;
  hostKey?: HostKeyInfo;
  initialPassword?: string;
  pending: boolean;
  step?: ConnectionLaunchStep;
  authMethod?: AuthMethod;
  onCancel(): void;
  onConfirmFingerprint(): void;
  onSubmitPassword(password: string, mode: CredentialMode): void;
  initialCredentialMode?: CredentialMode;
  keyboardPrompt?: Extract<KeyboardInteractiveEvent, { type: "prompt" }>;
  onSubmitKeyboardInteractive?(responses: string[]): void;
}

export function ConnectionLaunchDialog({
  connectionName,
  endpoint,
  errorMessage,
  hostKey,
  initialPassword,
  pending,
  step,
  authMethod = "password",
  onCancel,
  onConfirmFingerprint,
  onSubmitPassword,
  initialCredentialMode = "ask",
  keyboardPrompt,
  onSubmitKeyboardInteractive,
}: ConnectionLaunchDialogProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [password, setPassword] = useState(initialPassword ?? "");
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(
    initialCredentialMode,
  );
  const passwordStep = step === "password";
  const interactiveStep = step === "keyboardInteractive";
  const privateKeyStep = passwordStep && authMethod === "privateKey";
  const [interactiveResponses, setInteractiveResponses] = useState<string[]>(
    [],
  );

  useEffect(() => {
    // Prompt rounds replace the controlled response list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInteractiveResponses(keyboardPrompt?.prompts.map(() => "") ?? []);
  }, [keyboardPrompt]);

  useEffect(() => {
    if (passwordStep) {
      // Credential references can resolve after the dialog has opened.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPassword(initialPassword ?? "");
    }
  }, [initialPassword, passwordStep]);

  const submitPassword = () => {
    if (interactiveStep) {
      if (keyboardPrompt && !pending) {
        onSubmitKeyboardInteractive?.(interactiveResponses);
      } else if (!keyboardPrompt && !pending) {
        onSubmitPassword("", "ask");
      }
      return;
    }
    if ((!password && !privateKeyStep) || pending) return;
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
          ? t(
              privateKeyStep
                ? "connectionAuthentication.privateKeyTitle"
                : "connectionAuthentication.title",
            )
          : interactiveStep
            ? t("connectionAuthentication.keyboardInteractiveTitle")
            : t("hostFingerprint.title")
      }
      description={
        passwordStep
          ? t(
              privateKeyStep
                ? "connectionAuthentication.privateKeyDescription"
                : "connectionAuthentication.description",
              { name: connectionName },
            )
          : interactiveStep
            ? t("connectionAuthentication.keyboardInteractiveDescription", {
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
          {passwordStep || interactiveStep ? (
            <Button
              type="primary"
              loading={pending}
              disabled={
                interactiveStep
                  ? pending ||
                    (!!keyboardPrompt &&
                      interactiveResponses.length !==
                        keyboardPrompt.prompts.length)
                  : !password && !privateKeyStep
              }
              onClick={submitPassword}
            >
              {interactiveStep && !keyboardPrompt
                ? t("connectionAuthentication.startInteractive")
                : t("connectionAuthentication.connect")}
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
              {t(
                privateKeyStep
                  ? "connectionAuthentication.passphrase"
                  : "connectionAuthentication.password",
              )}
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
          {!privateKeyStep && (
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
                {(["ask", "session", "vault"] as CredentialMode[]).map(
                  (mode) => (
                    <Radio.Button key={mode} value={mode} disabled={pending}>
                      {t(`connectionAuthentication.modes.${mode}`)}
                    </Radio.Button>
                  ),
                )}
              </Radio.Group>
            </fieldset>
          )}
          {errorMessage && (
            <FeedbackNotice
              type="error"
              showIcon
              message={t("connectionAuthentication.failed")}
              description={errorMessage}
            />
          )}
          <p className="connection-auth-hint">
            {t(
              privateKeyStep
                ? "connectionAuthentication.privateKeyHint"
                : "connectionAuthentication.sessionOnly",
            )}
          </p>
        </>
      ) : interactiveStep ? (
        <>
          <div className="connection-auth-endpoint">
            <KeyRound size={16} aria-hidden="true" />
            <span>{endpoint}</span>
          </div>
          {keyboardPrompt ? (
            <div className="keyboard-interactive-prompts">
              {keyboardPrompt.name && (
                <p className="connection-auth-hint">{keyboardPrompt.name}</p>
              )}
              {keyboardPrompt.instructions && (
                <p className="connection-auth-hint">
                  {keyboardPrompt.instructions}
                </p>
              )}
              {keyboardPrompt.prompts.map((item, index) => (
                <label className="field-group" key={`${item.prompt}-${index}`}>
                  <span className="field-label">{item.prompt}</span>
                  {item.echo ? (
                    <Input
                      autoFocus={index === 0}
                      value={interactiveResponses[index] ?? ""}
                      disabled={pending}
                      onChange={(event) => {
                        const next = [...interactiveResponses];
                        next[index] = event.target.value;
                        setInteractiveResponses(next);
                      }}
                    />
                  ) : (
                    <Input.Password
                      autoFocus={index === 0}
                      value={interactiveResponses[index] ?? ""}
                      autoComplete="off"
                      disabled={pending}
                      onChange={(event) => {
                        const next = [...interactiveResponses];
                        next[index] = event.target.value;
                        setInteractiveResponses(next);
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
          ) : (
            <p className="connection-auth-hint">
              {t("connectionAuthentication.keyboardInteractiveWaiting")}
            </p>
          )}
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
