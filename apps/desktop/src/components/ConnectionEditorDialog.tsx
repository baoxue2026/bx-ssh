import { zodResolver } from "@hookform/resolvers/zod";
import { Button, Input, InputNumber, Radio, Select, Tabs } from "antd";
import { CircleAlert, Eraser, KeyRound, Settings2, Server } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Controller,
  useForm,
  useWatch,
  type FieldErrors,
} from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import type {
  AuthMethod,
  ConnectionConfig,
  ConnectionSettingsOverride,
} from "../ipc/bindings";
import { AppDialog, FeedbackNotice } from "./Feedback";
import { isValidSshHost } from "./hostValidation";

type ConnectionEditorTab = "basic" | "authentication" | "settings";

export interface ConnectionGroupOption {
  label: string;
  value: string;
}

export interface ConnectionEditorValue {
  config: ConnectionConfig;
  settings: ConnectionSettingsOverride;
  credentialMode?: CredentialMode;
  password?: string;
}

export interface ConnectionEditorDialogProps {
  errorMessage?: string;
  groupOptions?: ConnectionGroupOption[];
  initialValue?: ConnectionEditorValue;
  notice?: string;
  pending?: boolean;
  saveAndConnectDisabled?: boolean;
  onClose(): void;
  onSubmit(value: ConnectionEditorValue, intent: ConnectionEditorIntent): void;
  open: boolean;
}

export type ConnectionEditorIntent = "save" | "saveAndConnect";

export type CredentialMode = "ask" | "session" | "vault";

interface FormValues {
  authMethod: AuthMethod;
  color: string;
  connectTimeoutSecs: number | null;
  credentialMode: CredentialMode;
  credentialRef: string;
  groupId: string;
  host: string;
  keepAliveSecs: number | null;
  keyReferenceId: string;
  name: string;
  notes: string;
  password: string;
  port: number;
  username: string;
}

const BASIC_FIELDS: Array<keyof FormValues> = [
  "name",
  "host",
  "port",
  "username",
  "groupId",
  "notes",
  "color",
];
const AUTHENTICATION_FIELDS: Array<keyof FormValues> = [
  "authMethod",
  "credentialMode",
  "credentialRef",
  "keyReferenceId",
  "password",
];
const SETTINGS_FIELDS: Array<keyof FormValues> = [
  "connectTimeoutSecs",
  "keepAliveSecs",
];

export function ConnectionEditorDialog({
  errorMessage,
  groupOptions = [],
  initialValue,
  notice,
  pending = false,
  saveAndConnectDisabled = false,
  onClose,
  onSubmit,
  open,
}: ConnectionEditorDialogProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ConnectionEditorTab>("basic");
  const [editingSource, setEditingSource] = useState<
    ConnectionEditorValue | undefined
  >(initialValue);
  const [draftId, setDraftId] = useState(
    () => initialValue?.config.id ?? createConnectionId(),
  );
  const generatedFormId = useId().replaceAll(":", "");
  const formId = `connection-editor-${generatedFormId}`;
  const wasOpenRef = useRef(open);

  const schema = useMemo(
    () =>
      z
        .object({
          authMethod: z.enum(["password", "privateKey", "keyboardInteractive"]),
          color: z
            .string()
            .refine(
              (value) => value === "" || /^#[0-9a-fA-F]{6}$/.test(value),
              t("connectionEditor.validation.color"),
            ),
          connectTimeoutSecs: z
            .number()
            .int(t("connectionEditor.validation.wholeNumber"))
            .min(1, t("connectionEditor.validation.timeout"))
            .max(4_294_967_295, t("connectionEditor.validation.timeout"))
            .nullable(),
          credentialMode: z.enum(["ask", "session", "vault"]),
          credentialRef: z.string(),
          groupId: z.string(),
          host: z
            .string()
            .refine(
              (value) => value.trim().length > 0,
              t("connectionEditor.validation.required"),
            )
            .refine(
              (value) => !value || isValidSshHost(value),
              t("connectionEditor.validation.host"),
            ),
          keepAliveSecs: z
            .number()
            .int(t("connectionEditor.validation.wholeNumber"))
            .min(0, t("connectionEditor.validation.keepAlive"))
            .max(4_294_967_295, t("connectionEditor.validation.keepAlive"))
            .nullable(),
          keyReferenceId: z.string(),
          name: z
            .string()
            .refine(
              (value) => value.trim().length > 0,
              t("connectionEditor.validation.required"),
            ),
          notes: z.string(),
          password: z.string(),
          port: z
            .number()
            .int(t("connectionEditor.validation.port"))
            .min(1, t("connectionEditor.validation.port"))
            .max(65_535, t("connectionEditor.validation.port")),
          username: z
            .string()
            .refine(
              (value) => value.trim().length > 0,
              t("connectionEditor.validation.required"),
            ),
        })
        .superRefine((values, context) => {
          if (
            values.authMethod === "privateKey" &&
            !values.keyReferenceId.trim()
          ) {
            context.addIssue({
              code: "custom",
              message: t("connectionEditor.validation.required"),
              path: ["keyReferenceId"],
            });
          }
          if (
            values.authMethod === "password" &&
            values.credentialMode !== "ask" &&
            !values.password
          ) {
            context.addIssue({
              code: "custom",
              message: t("connectionEditor.validation.required"),
              path: ["password"],
            });
          }
          if (
            values.authMethod === "password" &&
            values.credentialMode === "vault" &&
            !values.credentialRef.trim()
          ) {
            context.addIssue({
              code: "custom",
              message: t("connectionEditor.validation.required"),
              path: ["credentialRef"],
            });
          }
        }),
    [t],
  );

  const {
    control,
    formState: { errors },
    handleSubmit,
    reset,
  } = useForm<FormValues>({
    defaultValues: toFormValues(initialValue),
    resolver: zodResolver(schema),
    shouldFocusError: false,
    shouldUnregister: false,
  });

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const nextDraftId = initialValue?.config.id ?? createConnectionId();
      setDraftId(nextDraftId);
      setEditingSource(initialValue);
      reset(toFormValues(initialValue));
      setActiveTab("basic");
    }
    wasOpenRef.current = open;
  }, [initialValue, open, reset]);

  const authMethod = useWatch({ control, name: "authMethod" });
  const credentialMode = useWatch({ control, name: "credentialMode" });
  const tabErrors: Record<ConnectionEditorTab, boolean> = {
    basic: hasFieldError(errors, BASIC_FIELDS),
    authentication: hasFieldError(errors, AUTHENTICATION_FIELDS),
    settings: hasFieldError(errors, SETTINGS_FIELDS),
  };

  const submit = (intent: ConnectionEditorIntent) =>
    handleSubmit(
      (values) => {
        onSubmit(toEditorValue(values, editingSource, draftId), intent);
      },
      (fieldErrors) => {
        const firstTab = firstErrorTab(fieldErrors);
        setActiveTab(firstTab);
        const firstField = firstErrorField(fieldErrors, firstTab);
        if (firstField) {
          requestAnimationFrame(() =>
            document.getElementById(fieldId(firstField))?.focus(),
          );
        }
      },
    );

  const tabs = [
    {
      key: "basic",
      label: (
        <TabLabel
          error={tabErrors.basic}
          icon={<Server size={14} />}
          label={t("connectionEditor.tabs.basic")}
        />
      ),
      children: (
        <div className="connection-editor-grid">
          <Field
            error={errors.name?.message}
            id="connection-name"
            label={t("connectionEditor.fields.name")}
            required
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="name"
                render={({ field }) => (
                  <Input
                    id="connection-name"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    aria-required="true"
                    autoComplete="off"
                    placeholder={t("connectionEditor.placeholders.name")}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                  />
                )}
              />
            )}
          </Field>

          <div className="connection-editor-endpoint">
            <Field
              error={errors.host?.message}
              help={t("connectionEditor.help.host")}
              id="connection-host"
              label={t("connectionEditor.fields.host")}
              required
            >
              {(describedBy, invalid) => (
                <Controller
                  control={control}
                  name="host"
                  render={({ field }) => (
                    <Input
                      id="connection-host"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      aria-required="true"
                      autoCapitalize="none"
                      autoComplete="off"
                      placeholder={t("connectionEditor.placeholders.host")}
                      spellCheck={false}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  )}
                />
              )}
            </Field>
            <Field
              error={errors.port?.message}
              id="connection-port"
              label={t("connectionEditor.fields.port")}
              required
            >
              {(describedBy, invalid) => (
                <Controller
                  control={control}
                  name="port"
                  render={({ field }) => (
                    <InputNumber
                      id="connection-port"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      aria-required="true"
                      aria-valuemax={65_535}
                      aria-valuemin={1}
                      controls={false}
                      precision={0}
                      value={Number.isNaN(field.value) ? null : field.value}
                      onBlur={field.onBlur}
                      onChange={(value) => field.onChange(value ?? Number.NaN)}
                    />
                  )}
                />
              )}
            </Field>
          </div>

          <Field
            error={errors.username?.message}
            id="connection-username"
            label={t("connectionEditor.fields.username")}
            required
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="username"
                render={({ field }) => (
                  <Input
                    id="connection-username"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    aria-required="true"
                    autoCapitalize="none"
                    autoComplete="username"
                    placeholder={t("connectionEditor.placeholders.username")}
                    spellCheck={false}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                  />
                )}
              />
            )}
          </Field>

          <Field
            error={errors.groupId?.message}
            help={
              groupOptions.length === 0
                ? t("connectionEditor.help.noGroups")
                : undefined
            }
            id="connection-group"
            label={t("connectionEditor.fields.group")}
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="groupId"
                render={({ field }) => (
                  <Select
                    id="connection-group"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    allowClear
                    options={groupOptions}
                    placeholder={t("connectionEditor.placeholders.group")}
                    showSearch
                    value={field.value || undefined}
                    optionFilterProp="label"
                    onBlur={field.onBlur}
                    onChange={(value) => field.onChange(value ?? "")}
                  />
                )}
              />
            )}
          </Field>

          <Field
            error={errors.notes?.message}
            id="connection-notes"
            label={t("connectionEditor.fields.notes")}
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="notes"
                render={({ field }) => (
                  <Input.TextArea
                    id="connection-notes"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    autoComplete="off"
                    placeholder={t("connectionEditor.placeholders.notes")}
                    rows={3}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                  />
                )}
              />
            )}
          </Field>

          <Field
            error={errors.color?.message}
            help={t("connectionEditor.help.color")}
            id="connection-color"
            label={t("connectionEditor.fields.color")}
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="color"
                render={({ field }) => (
                  <div className="connection-color-control">
                    <input
                      id="connection-color"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      aria-label={t("connectionEditor.fields.color")}
                      className="connection-color-swatch"
                      type="color"
                      value={field.value || "#1677ff"}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                    <code>
                      {field.value || t("connectionEditor.fields.noColor")}
                    </code>
                    <Button
                      aria-label={t("connectionEditor.actions.clearColor")}
                      disabled={!field.value}
                      icon={<Eraser size={15} />}
                      type="text"
                      onClick={() => field.onChange("")}
                    />
                  </div>
                )}
              />
            )}
          </Field>
        </div>
      ),
    },
    {
      key: "authentication",
      label: (
        <TabLabel
          error={tabErrors.authentication}
          icon={<KeyRound size={14} />}
          label={t("connectionEditor.tabs.authentication")}
        />
      ),
      children: (
        <div className="connection-editor-grid">
          <Field
            error={errors.authMethod?.message}
            help={t("connectionEditor.help.authentication")}
            id="connection-auth-method"
            label={t("connectionEditor.fields.authMethod")}
            required
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="authMethod"
                render={({ field }) => (
                  <Radio.Group
                    id="connection-auth-method"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    aria-required="true"
                    className="connection-auth-options"
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                  >
                    <Radio value="password">
                      {t("connectionEditor.auth.password")}
                    </Radio>
                    <Radio value="privateKey">
                      {t("connectionEditor.auth.privateKey")}
                    </Radio>
                    <Radio value="keyboardInteractive">
                      {t("connectionEditor.auth.keyboardInteractive")}
                    </Radio>
                  </Radio.Group>
                )}
              />
            )}
          </Field>

          <div hidden={authMethod !== "password"}>
            <Field
              error={errors.credentialMode?.message}
              help={t("connectionEditor.help.credentialMode")}
              id="connection-credential-mode"
              label={t("connectionEditor.fields.credentialMode")}
              required
            >
              {(describedBy, invalid) => (
                <Controller
                  control={control}
                  name="credentialMode"
                  render={({ field }) => (
                    <Radio.Group
                      id="connection-credential-mode"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      aria-required="true"
                      className="connection-auth-options"
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                    >
                      <Radio value="ask">
                        {t("connectionEditor.credentialMode.ask")}
                      </Radio>
                      <Radio value="session">
                        {t("connectionEditor.credentialMode.session")}
                      </Radio>
                      <Radio value="vault">
                        {t("connectionEditor.credentialMode.vault")}
                      </Radio>
                    </Radio.Group>
                  )}
                />
              )}
            </Field>
          </div>

          <div hidden={authMethod !== "password" || credentialMode === "ask"}>
            <Field
              error={errors.password?.message}
              help={t("connectionEditor.help.password")}
              id="connection-password"
              label={t("connectionEditor.fields.password")}
            >
              {(describedBy, invalid) => (
                <Controller
                  control={control}
                  name="password"
                  render={({ field }) => (
                    <Input.Password
                      id="connection-password"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      autoComplete="new-password"
                      placeholder={t("connectionEditor.placeholders.password")}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  )}
                />
              )}
            </Field>
          </div>

          <div hidden={authMethod !== "password"}>
            <Field
              error={errors.credentialRef?.message}
              help={t("connectionEditor.help.credentialRef")}
              id="connection-credential-ref"
              label={t("connectionEditor.fields.credentialRef")}
            >
              {(describedBy, invalid) => (
                <Controller
                  control={control}
                  name="credentialRef"
                  render={({ field }) => (
                    <Input
                      id="connection-credential-ref"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      autoComplete="off"
                      placeholder={t(
                        "connectionEditor.placeholders.credentialRef",
                      )}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  )}
                />
              )}
            </Field>
          </div>

          <div hidden={authMethod !== "privateKey"}>
            <Field
              error={errors.keyReferenceId?.message}
              help={t("connectionEditor.help.keyReference")}
              id="connection-key-reference"
              label={t("connectionEditor.fields.keyReference")}
              required={authMethod === "privateKey"}
            >
              {(describedBy, invalid) => (
                <Controller
                  control={control}
                  name="keyReferenceId"
                  render={({ field }) => (
                    <Input
                      id="connection-key-reference"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      aria-required={authMethod === "privateKey"}
                      autoComplete="off"
                      placeholder={t(
                        "connectionEditor.placeholders.keyReference",
                      )}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  )}
                />
              )}
            </Field>
          </div>

          {authMethod === "keyboardInteractive" && (
            <div className="connection-auth-hint" role="status">
              {t("connectionEditor.help.keyboardInteractive")}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "settings",
      label: (
        <TabLabel
          error={tabErrors.settings}
          icon={<Settings2 size={14} />}
          label={t("connectionEditor.tabs.settings")}
        />
      ),
      children: (
        <div className="connection-editor-grid connection-settings-grid">
          <Field
            error={errors.connectTimeoutSecs?.message}
            help={t("connectionEditor.help.inheritTimeout")}
            id="connection-timeout"
            label={t("connectionEditor.fields.connectTimeout")}
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="connectTimeoutSecs"
                render={({ field }) => (
                  <InputNumber
                    id="connection-timeout"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    controls
                    max={4_294_967_295}
                    min={1}
                    placeholder="10"
                    precision={0}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                  />
                )}
              />
            )}
          </Field>
          <Field
            error={errors.keepAliveSecs?.message}
            help={t("connectionEditor.help.inheritKeepAlive")}
            id="connection-keep-alive"
            label={t("connectionEditor.fields.keepAlive")}
          >
            {(describedBy, invalid) => (
              <Controller
                control={control}
                name="keepAliveSecs"
                render={({ field }) => (
                  <InputNumber
                    id="connection-keep-alive"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    controls
                    max={4_294_967_295}
                    min={0}
                    placeholder="30"
                    precision={0}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                  />
                )}
              />
            )}
          </Field>
        </div>
      ),
    },
  ];

  const editing = Boolean(initialValue);

  return (
    <AppDialog
      className="connection-editor-dialog"
      description={t("connectionEditor.description")}
      footer={
        <>
          <Button
            aria-label={t("common.cancel")}
            disabled={pending}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            aria-label={t("connectionEditor.actions.saveAndConnect")}
            disabled={pending || saveAndConnectDisabled}
            title={
              saveAndConnectDisabled
                ? t("connectionEditor.saveAndConnectUnavailable")
                : undefined
            }
            onClick={() => void submit("saveAndConnect")()}
          >
            {t("connectionEditor.actions.saveAndConnect")}
          </Button>
          <Button
            aria-label={t("connectionEditor.actions.save")}
            disabled={pending}
            loading={pending}
            type="primary"
            onClick={() => void submit("save")()}
          >
            {t("connectionEditor.actions.save")}
          </Button>
        </>
      }
      closable={!pending}
      closeOnEscape={!pending}
      maskClosable={false}
      open={open}
      title={t(
        editing ? "connectionEditor.titleEdit" : "connectionEditor.titleNew",
      )}
      width={660}
      onClose={onClose}
    >
      {notice && (
        <FeedbackNotice
          className="connection-editor-notice"
          message={notice}
          showIcon
          type="info"
        />
      )}
      {errorMessage && (
        <FeedbackNotice
          className="connection-editor-notice"
          message={t("connectionEditor.saveFailed")}
          description={errorMessage}
          showIcon
          type="error"
        />
      )}
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit("save")();
        }}
      >
        <Tabs
          activeKey={activeTab}
          aria-label={t("connectionEditor.tabs.label")}
          items={tabs}
          onChange={(key) => setActiveTab(key as ConnectionEditorTab)}
        />
      </form>
    </AppDialog>
  );
}

interface FieldProps {
  children(describedBy: string | undefined, invalid: boolean): ReactNode;
  error?: string;
  help?: string;
  id: string;
  label: string;
  required?: boolean;
}

function Field({ children, error, help, id, label, required }: FieldProps) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`connection-editor-field${error ? " has-error" : ""}`}>
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="required-mark" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children(describedBy, Boolean(error))}
      {help && (
        <span className="connection-editor-help" id={helpId}>
          {help}
        </span>
      )}
      {error && (
        <span className="connection-editor-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function TabLabel({
  error,
  icon,
  label,
}: {
  error: boolean;
  icon: ReactNode;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <span className="connection-editor-tab-label">
      {icon}
      <span>{label}</span>
      {error && (
        <CircleAlert
          aria-label={t("connectionEditor.tabs.hasError", { tab: label })}
          className="connection-editor-tab-error"
          size={14}
        />
      )}
    </span>
  );
}

function toFormValues(value: ConnectionEditorValue | undefined): FormValues {
  return {
    authMethod: value?.config.authMethod ?? "password",
    color: value?.config.color ?? "",
    connectTimeoutSecs: value?.settings.connectTimeoutSecs ?? null,
    credentialMode:
      value?.credentialMode ?? (value?.config.credentialRef ? "vault" : "ask"),
    credentialRef: value?.config.credentialRef ?? "",
    groupId: value?.config.groupId ?? "",
    host: value?.config.host ?? "",
    keepAliveSecs: value?.settings.keepAliveSecs ?? null,
    keyReferenceId: value?.config.keyReferenceId ?? "",
    name: value?.config.name ?? "",
    notes: value?.config.notes ?? "",
    password: "",
    port: value?.config.port ?? 22,
    username: value?.config.username ?? "",
  };
}

function toEditorValue(
  values: FormValues,
  initialValue: ConnectionEditorValue | undefined,
  draftId: string,
): ConnectionEditorValue {
  return {
    config: {
      id: initialValue?.config.id ?? draftId,
      groupId: emptyToNull(values.groupId),
      name: values.name.trim(),
      host: values.host.trim(),
      port: values.port,
      username: values.username.trim(),
      notes: emptyToNull(values.notes),
      color: emptyToNull(values.color),
      authMethod: values.authMethod,
      credentialRef:
        values.authMethod === "password" && values.credentialMode === "vault"
          ? emptyToNull(values.credentialRef)
          : null,
      keyReferenceId:
        values.authMethod === "privateKey"
          ? emptyToNull(values.keyReferenceId)
          : null,
    },
    settings: {
      connectTimeoutSecs: values.connectTimeoutSecs,
      keepAliveSecs: values.keepAliveSecs,
    },
    credentialMode: values.credentialMode,
    ...(values.authMethod === "password" &&
    values.credentialMode !== "ask" &&
    values.password
      ? { password: values.password }
      : {}),
  };
}

function emptyToNull(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function hasFieldError(
  errors: FieldErrors<FormValues>,
  fields: Array<keyof FormValues>,
): boolean {
  return fields.some((field) => Boolean(errors[field]));
}

function firstErrorTab(errors: FieldErrors<FormValues>): ConnectionEditorTab {
  if (hasFieldError(errors, BASIC_FIELDS)) return "basic";
  if (hasFieldError(errors, AUTHENTICATION_FIELDS)) return "authentication";
  return "settings";
}

function firstErrorField(
  errors: FieldErrors<FormValues>,
  tab: ConnectionEditorTab,
): keyof FormValues | undefined {
  const fields =
    tab === "basic"
      ? BASIC_FIELDS
      : tab === "authentication"
        ? AUTHENTICATION_FIELDS
        : SETTINGS_FIELDS;
  return fields.find((field) => Boolean(errors[field]));
}

function fieldId(field: keyof FormValues): string {
  const ids: Record<keyof FormValues, string> = {
    authMethod: "connection-auth-method",
    color: "connection-color",
    connectTimeoutSecs: "connection-timeout",
    credentialRef: "connection-credential-ref",
    credentialMode: "connection-credential-mode",
    groupId: "connection-group",
    host: "connection-host",
    keepAliveSecs: "connection-keep-alive",
    keyReferenceId: "connection-key-reference",
    name: "connection-name",
    notes: "connection-notes",
    password: "connection-password",
    port: "connection-port",
    username: "connection-username",
  };
  return ids[field];
}

function createConnectionId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return `connection-${id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
