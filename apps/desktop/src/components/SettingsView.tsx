import { useMemo, useState, type ReactNode } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Button, Input, InputNumber, Select, Switch } from "antd";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Keyboard,
  Key,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareTerminal,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ApplicationSettings,
  ConnectionGroup,
  ConnectionSettings,
  GlobalSettingsSnapshot,
} from "../ipc/bindings";
import {
  DEFAULT_APPLICATION_SETTINGS,
  DEFAULT_GLOBAL_CONNECTION_SETTINGS,
} from "../ui/applicationSettings";
import { FeedbackNotice } from "./Feedback";

type SettingsCategory =
  | "general"
  | "terminal"
  | "appearance"
  | "connection"
  | "sftp"
  | "security"
  | "shortcuts"
  | "update"
  | "logs";

interface SettingsViewProps {
  appName: string;
  errorMessage?: string;
  groups: ConnectionGroup[];
  left: number;
  loading?: boolean;
  notice?: string;
  saving?: boolean;
  settings: GlobalSettingsSnapshot;
  version: string;
  onCheckForUpdates(): void;
  onExportDiagnostics(): void;
  onOpenLogDirectory(): void;
  onManageSshKeys?(): void;
  onClose(): void;
  onSave(
    application: ApplicationSettings,
    connection: ConnectionSettings,
  ): void;
}

const categories: Array<{ icon: LucideIcon; id: SettingsCategory }> = [
  { id: "general", icon: SettingsIcon },
  { id: "terminal", icon: SquareTerminal },
  { id: "appearance", icon: Palette },
  { id: "connection", icon: Wifi },
  { id: "sftp", icon: FolderOpen },
  { id: "security", icon: ShieldCheck },
  { id: "shortcuts", icon: Keyboard },
  { id: "update", icon: RefreshCw },
  { id: "logs", icon: ScrollText },
];

export function SettingsView({
  appName,
  errorMessage,
  groups,
  left,
  loading = false,
  notice,
  saving = false,
  settings,
  version,
  onCheckForUpdates,
  onExportDiagnostics,
  onOpenLogDirectory,
  onManageSshKeys = () => {},
  onClose,
  onSave,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<SettingsCategory>("general");
  const [draft, setDraft] = useState(settings);
  const [source, setSource] = useState(settings);
  const [browseError, setBrowseError] = useState<string>();

  if (settings !== source) {
    setSource(settings);
    setDraft(settings);
  }

  const dirty = useMemo(
    () =>
      !settings.applicationInitialized ||
      JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );
  const disabled = loading || saving;

  const updateApplication = (patch: Partial<ApplicationSettings>) => {
    setDraft((current) => ({
      ...current,
      application: { ...current.application, ...patch },
    }));
  };

  const browseLocalDirectory = async () => {
    setBrowseError(undefined);
    try {
      const selected = await openFileDialog({
        defaultPath: draft.application.sftpDefaultLocalDirectory ?? undefined,
        directory: true,
        multiple: false,
        title: t("settings.actions.chooseLocalDirectory"),
      });
      if (typeof selected === "string") {
        updateApplication({ sftpDefaultLocalDirectory: selected });
      }
    } catch {
      setBrowseError(t("settings.feedback.directoryUnavailable"));
    }
  };

  return (
    <section
      className="settings-view"
      style={{ left }}
      aria-labelledby="settings-title"
    >
      <header className="settings-header">
        <strong id="settings-title">{t("settings.title")}</strong>
        <Button
          aria-label={t("settings.close")}
          disabled={saving}
          icon={<X size={15} />}
          size="small"
          type="text"
          onClick={onClose}
        />
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.navigation")}>
          {categories.map(({ icon: Icon, id }) => (
            <button
              className={`settings-nav-item${active === id ? " is-active" : ""}`}
              key={id}
              type="button"
              aria-current={active === id ? "page" : undefined}
              onClick={() => setActive(id)}
            >
              <Icon size={14} />
              <span>{t(`settings.categories.${id}`)}</span>
            </button>
          ))}
        </nav>

        <main className="settings-content">
          <div className="settings-content-inner">
            <h2>{t(`settings.categories.${active}`)}</h2>
            {(errorMessage || browseError) && (
              <FeedbackNotice
                type="error"
                showIcon
                message={t("settings.feedback.saveFailed")}
                description={errorMessage ?? browseError}
              />
            )}
            {notice && !errorMessage && !browseError && (
              <FeedbackNotice type="success" showIcon message={notice} />
            )}
            <SettingsContent
              active={active}
              appName={appName}
              disabled={disabled}
              draft={draft}
              groups={groups}
              version={version}
              onBrowseLocalDirectory={() => void browseLocalDirectory()}
              onCheckForUpdates={onCheckForUpdates}
              onExportDiagnostics={onExportDiagnostics}
              onOpenLogDirectory={onOpenLogDirectory}
              onManageSshKeys={onManageSshKeys}
              onConnectionChange={(connection) =>
                setDraft((current) => ({ ...current, connection }))
              }
              onApplicationChange={updateApplication}
            />
          </div>
        </main>
      </div>

      <footer className="settings-footer">
        <span className="settings-save-state" role="status">
          {loading
            ? t("settings.feedback.loading")
            : dirty
              ? t("settings.feedback.unsaved")
              : t("settings.feedback.saved")}
        </span>
        <div className="settings-footer-actions">
          <Button
            disabled={disabled || active === "shortcuts"}
            icon={<RotateCcw size={13} />}
            onClick={() => setDraft(resetCategory(draft, active))}
          >
            {t("settings.actions.restoreDefaults")}
          </Button>
          <Button
            disabled={disabled || !dirty}
            icon={<Save size={13} />}
            loading={saving}
            type="primary"
            onClick={() =>
              onSave(
                {
                  ...draft.application,
                  sftpDefaultLocalDirectory:
                    draft.application.sftpDefaultLocalDirectory?.trim() || null,
                },
                draft.connection,
              )
            }
          >
            {t("settings.actions.save")}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function SettingsContent({
  active,
  appName,
  disabled,
  draft,
  groups,
  version,
  onApplicationChange,
  onBrowseLocalDirectory,
  onCheckForUpdates,
  onConnectionChange,
  onExportDiagnostics,
  onOpenLogDirectory,
  onManageSshKeys,
}: {
  active: SettingsCategory;
  appName: string;
  disabled: boolean;
  draft: GlobalSettingsSnapshot;
  groups: ConnectionGroup[];
  version: string;
  onApplicationChange(patch: Partial<ApplicationSettings>): void;
  onBrowseLocalDirectory(): void;
  onCheckForUpdates(): void;
  onConnectionChange(connection: ConnectionSettings): void;
  onExportDiagnostics(): void;
  onOpenLogDirectory(): void;
  onManageSshKeys(): void;
}) {
  const { t } = useTranslation();
  const application = draft.application;

  if (active === "general") {
    return (
      <>
        <SettingsSection title={t("settings.sections.application")}>
          <SettingsRow
            title={t("appearance.language")}
            description={t("settings.descriptions.language")}
          >
            <Select
              aria-label={t("appearance.language")}
              className="settings-control"
              disabled={disabled}
              value={application.language}
              options={[
                { label: t("appearance.languageChinese"), value: "zh-CN" },
                { label: t("appearance.languageEnglish"), value: "en-US" },
              ]}
              onChange={(language) => onApplicationChange({ language })}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.confirmClose")}
            description={t("settings.descriptions.confirmClose")}
          >
            <Switch
              aria-label={t("settings.rows.confirmClose")}
              checked={application.confirmClose}
              disabled={disabled}
              onChange={(confirmClose) => onApplicationChange({ confirmClose })}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.singleInstance")}
            description={t("settings.descriptions.singleInstance")}
          >
            <ReadOnlyToggle label={t("settings.rows.singleInstance")} />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.connectionList")}>
          <SettingsRow
            title={t("settings.rows.defaultGroup")}
            description={t("settings.descriptions.defaultGroup")}
          >
            <Select
              aria-label={t("settings.rows.defaultGroup")}
              className="settings-control"
              disabled={disabled}
              value={application.defaultGroupId ?? ""}
              options={[
                { label: t("settings.values.ungrouped"), value: "" },
                ...groups.map((group) => ({
                  label: group.name,
                  value: group.id,
                })),
              ]}
              onChange={(defaultGroupId) =>
                onApplicationChange({ defaultGroupId: defaultGroupId || null })
              }
            />
          </SettingsRow>
        </SettingsSection>
      </>
    );
  }

  if (active === "appearance") {
    return (
      <SettingsSection title={t("appearance.theme")}>
        <div
          className="settings-theme-options"
          role="radiogroup"
          aria-label={t("appearance.theme")}
        >
          {(["light", "dark", "system"] as const).map((themeMode) => (
            <button
              className={`settings-theme-option${application.themeMode === themeMode ? " is-active" : ""}`}
              disabled={disabled}
              key={themeMode}
              type="button"
              role="radio"
              aria-checked={application.themeMode === themeMode}
              onClick={() => onApplicationChange({ themeMode })}
            >
              <span className={`settings-theme-preview mode-${themeMode}`}>
                <span />
                <span />
              </span>
              <span>{t(`appearance.theme${capitalize(themeMode)}`)}</span>
            </button>
          ))}
        </div>
        <SettingsRow
          title={t("settings.rows.compactLayout")}
          description={t("settings.descriptions.compactLayout")}
        >
          <Switch
            aria-label={t("settings.rows.compactLayout")}
            checked={application.compactLayout}
            disabled={disabled}
            onChange={(compactLayout) => onApplicationChange({ compactLayout })}
          />
        </SettingsRow>
      </SettingsSection>
    );
  }

  if (active === "terminal") {
    return (
      <>
        <SettingsSection title={t("settings.sections.terminalFont")}>
          <SettingsRow
            title={t("settings.rows.terminalFont")}
            description={t("settings.descriptions.terminalFont")}
          >
            <Select
              aria-label={t("settings.rows.terminalFont")}
              className="settings-control"
              disabled={disabled}
              value={application.terminalFontFamily}
              options={[
                { label: "Cascadia Mono", value: "cascadiaMono" },
                { label: "Cascadia Code", value: "cascadiaCode" },
                { label: "Consolas", value: "consolas" },
              ]}
              onChange={(terminalFontFamily) =>
                onApplicationChange({ terminalFontFamily })
              }
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.terminalFontSize")}
            description={t("settings.descriptions.terminalFontSize")}
          >
            <InputNumber
              aria-label={t("settings.rows.terminalFontSize")}
              className="settings-number"
              controls={false}
              disabled={disabled}
              max={20}
              min={10}
              value={application.terminalFontSize}
              onChange={(terminalFontSize) => {
                if (terminalFontSize !== null) {
                  onApplicationChange({ terminalFontSize });
                }
              }}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.terminalLineHeight")}
            description={t("settings.descriptions.terminalLineHeight")}
          >
            <Select
              aria-label={t("settings.rows.terminalLineHeight")}
              className="settings-control"
              disabled={disabled}
              value={application.terminalLineHeight}
              options={[
                { label: t("settings.values.compact"), value: "compact" },
                { label: t("settings.values.standard"), value: "standard" },
                { label: t("settings.values.relaxed"), value: "relaxed" },
              ]}
              onChange={(terminalLineHeight) =>
                onApplicationChange({ terminalLineHeight })
              }
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.terminalAppearance")}>
          <SettingsRow
            title={t("settings.rows.terminalCursorStyle")}
            description={t("settings.descriptions.terminalCursorStyle")}
          >
            <Select
              aria-label={t("settings.rows.terminalCursorStyle")}
              className="settings-control"
              disabled={disabled}
              value={application.terminalCursorStyle}
              options={[
                { label: t("settings.values.cursorBlock"), value: "block" },
                {
                  label: t("settings.values.cursorUnderline"),
                  value: "underline",
                },
                { label: t("settings.values.cursorBar"), value: "bar" },
              ]}
              onChange={(terminalCursorStyle) =>
                onApplicationChange({ terminalCursorStyle })
              }
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.terminalCursorBlink")}
            description={t("settings.descriptions.terminalCursorBlink")}
          >
            <Switch
              aria-label={t("settings.rows.terminalCursorBlink")}
              checked={application.terminalCursorBlink}
              disabled={disabled}
              onChange={(terminalCursorBlink) =>
                onApplicationChange({ terminalCursorBlink })
              }
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.terminalColorScheme")}
            description={t("settings.descriptions.terminalColorScheme")}
          >
            <Select
              aria-label={t("settings.rows.terminalColorScheme")}
              className="settings-control"
              disabled={disabled}
              value={application.terminalColorScheme}
              options={[
                { label: t("settings.values.bxDark"), value: "bxDark" },
                {
                  label: t("settings.values.solarizedDark"),
                  value: "solarizedDark",
                },
                { label: t("settings.values.bxLight"), value: "bxLight" },
              ]}
              onChange={(terminalColorScheme) =>
                onApplicationChange({ terminalColorScheme })
              }
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.input")}>
          <SettingsRow
            title={t("settings.rows.multilinePaste")}
            description={t("settings.descriptions.multilinePaste")}
          >
            <Switch
              aria-label={t("settings.rows.multilinePaste")}
              checked={application.multilinePasteConfirmation}
              disabled={disabled}
              onChange={(multilinePasteConfirmation) =>
                onApplicationChange({ multilinePasteConfirmation })
              }
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.copyOnSelect")}
            description={t("settings.descriptions.copyOnSelect")}
          >
            <Switch
              aria-label={t("settings.rows.copyOnSelect")}
              checked={application.copyOnSelect}
              disabled={disabled}
              onChange={(copyOnSelect) => onApplicationChange({ copyOnSelect })}
            />
          </SettingsRow>
        </SettingsSection>
      </>
    );
  }

  if (active === "connection") {
    return (
      <SettingsSection title={t("settings.sections.connectionDefaults")}>
        <SettingsRow
          title={t("settings.rows.connectTimeout")}
          description={t("settings.descriptions.connectTimeout")}
        >
          <SettingNumber
            disabled={disabled}
            min={1}
            unit={t("settings.units.seconds")}
            value={draft.connection.connectTimeoutSecs}
            onChange={(connectTimeoutSecs) =>
              onConnectionChange({ ...draft.connection, connectTimeoutSecs })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.rows.keepAlive")}
          description={t("settings.descriptions.keepAlive")}
        >
          <SettingNumber
            disabled={disabled}
            min={0}
            unit={t("settings.units.seconds")}
            value={draft.connection.keepAliveSecs}
            onChange={(keepAliveSecs) =>
              onConnectionChange({ ...draft.connection, keepAliveSecs })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.rows.reconnectConfirm")}
          description={t("settings.descriptions.reconnectConfirm")}
        >
          <Switch
            aria-label={t("settings.rows.reconnectConfirm")}
            checked={application.reconnectConfirmation}
            disabled={disabled}
            onChange={(reconnectConfirmation) =>
              onApplicationChange({ reconnectConfirmation })
            }
          />
        </SettingsRow>
      </SettingsSection>
    );
  }

  if (active === "sftp") {
    return (
      <>
        <SettingsSection title={t("settings.sections.directory")}>
          <SettingsRow
            title={t("settings.rows.defaultLocalDirectory")}
            description={t("settings.descriptions.defaultLocalDirectory")}
          >
            <div className="settings-inline-control">
              <Input
                aria-label={t("settings.rows.defaultLocalDirectory")}
                disabled={disabled}
                placeholder={t("settings.values.systemDefault")}
                value={application.sftpDefaultLocalDirectory ?? ""}
                onChange={(event) =>
                  onApplicationChange({
                    sftpDefaultLocalDirectory: event.target.value || null,
                  })
                }
              />
              <Button
                disabled={disabled}
                icon={<FolderOpen size={13} />}
                onClick={onBrowseLocalDirectory}
              >
                {t("settings.actions.browse")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.fileConflict")}>
          <SettingsRow
            title={t("settings.rows.fileConflict")}
            description={t("settings.descriptions.fileConflict")}
          >
            <Select
              aria-label={t("settings.rows.fileConflict")}
              className="settings-control"
              disabled={disabled}
              value={application.sftpConflictAction}
              options={[
                { label: t("settings.values.askEveryTime"), value: "ask" },
                { label: t("settings.values.skip"), value: "skip" },
                { label: t("settings.values.autoRename"), value: "rename" },
                { label: t("settings.values.overwrite"), value: "overwrite" },
              ]}
              onChange={(sftpConflictAction) =>
                onApplicationChange({ sftpConflictAction })
              }
            />
          </SettingsRow>
        </SettingsSection>
      </>
    );
  }

  if (active === "security") {
    return (
      <>
        <SettingsSection title={t("settings.sections.credentialStore")}>
          <div className="settings-credential-status" role="status">
            <CheckCircle2 size={17} />
            <div>
              <strong>{t("settings.credentialStore.connected")}</strong>
              <span>{t("settings.credentialStore.description")}</span>
            </div>
          </div>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.securityConfirmation")}>
          <SettingsRow
            title={t("settings.rows.externalLinkConfirm")}
            description={t("settings.descriptions.externalLinkConfirm")}
          >
            <Switch
              aria-label={t("settings.rows.externalLinkConfirm")}
              checked={application.externalLinkConfirmation}
              disabled={disabled}
              onChange={(externalLinkConfirmation) =>
                onApplicationChange({ externalLinkConfirmation })
              }
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.excludeCredentials")}
            description={t("settings.descriptions.excludeCredentials")}
          >
            <Switch
              aria-label={t("settings.rows.excludeCredentials")}
              checked={application.excludeCredentialsFromExport}
              disabled={disabled}
              onChange={(excludeCredentialsFromExport) =>
                onApplicationChange({ excludeCredentialsFromExport })
              }
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.sshKeys")}>
          <Button
            disabled={disabled}
            icon={<Key size={13} />}
            onClick={onManageSshKeys}
          >
            {t("settings.actions.manageSshKeys")}
          </Button>
        </SettingsSection>
      </>
    );
  }

  if (active === "update") {
    return (
      <SettingsSection title={t("settings.sections.update")}>
        <div className="settings-version">
          <div>
            <span>{t("settings.rows.currentVersion")}</span>
            <strong>
              {appName} {version}
            </strong>
          </div>
          <span className="settings-version-badge">
            {t("settings.values.notChecked")}
          </span>
        </div>
        <SettingsRow
          title={t("settings.rows.autoUpdate")}
          description={t("settings.descriptions.autoUpdate")}
        >
          <Switch
            aria-label={t("settings.rows.autoUpdate")}
            checked={application.autoCheckUpdates}
            disabled={disabled}
            onChange={(autoCheckUpdates) =>
              onApplicationChange({ autoCheckUpdates })
            }
          />
        </SettingsRow>
        <Button icon={<RefreshCw size={13} />} onClick={onCheckForUpdates}>
          {t("menu.checkUpdates")}
        </Button>
      </SettingsSection>
    );
  }

  if (active === "shortcuts") {
    return (
      <SettingsSection title={t("settings.sections.shortcuts")}>
        <div className="settings-shortcut-list">
          <ShortcutRow
            label={t("settings.shortcuts.newConnection")}
            value="Ctrl+N"
          />
          <ShortcutRow
            label={t("settings.shortcuts.closeSession")}
            value="Ctrl+Shift+W"
          />
          <ShortcutRow
            label={t("settings.shortcuts.searchTerminal")}
            value="Ctrl+Shift+F"
          />
          <ShortcutRow
            label={t("settings.shortcuts.copySelection")}
            value="Ctrl+Shift+C"
          />
          <ShortcutRow
            label={t("settings.shortcuts.pasteTerminal")}
            value="Ctrl+Shift+V"
          />
          <ShortcutRow label={t("connectionSidebar.collapse")} value="Ctrl+B" />
        </div>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title={t("settings.sections.logs")}>
        <SettingsRow
          title={t("settings.rows.logLevel")}
          description={t("settings.descriptions.logLevel")}
        >
          <Select
            aria-label={t("settings.rows.logLevel")}
            className="settings-control"
            disabled={disabled}
            value={application.logLevel}
            options={[
              { label: t("settings.values.error"), value: "error" },
              { label: t("settings.values.warning"), value: "warn" },
              { label: t("settings.values.info"), value: "info" },
              { label: t("settings.values.debug"), value: "debug" },
            ]}
            onChange={(logLevel) => onApplicationChange({ logLevel })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings.sections.diagnostics")}>
        <div className="settings-button-row">
          <Button
            disabled={disabled}
            icon={<ExternalLink size={13} />}
            onClick={onOpenLogDirectory}
          >
            {t("settings.actions.openLogDirectory")}
          </Button>
          <Button
            disabled={disabled}
            type="primary"
            icon={<Download size={13} />}
            onClick={onExportDiagnostics}
          >
            {t("settings.actions.exportDiagnostics")}
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}

function resetCategory(
  current: GlobalSettingsSnapshot,
  category: SettingsCategory,
): GlobalSettingsSnapshot {
  const defaults = DEFAULT_APPLICATION_SETTINGS;
  if (category === "general") {
    return {
      ...current,
      application: {
        ...current.application,
        language: defaults.language,
        confirmClose: defaults.confirmClose,
        defaultGroupId: defaults.defaultGroupId,
      },
    };
  }
  if (category === "appearance") {
    return {
      ...current,
      application: {
        ...current.application,
        themeMode: defaults.themeMode,
        compactLayout: defaults.compactLayout,
      },
    };
  }
  if (category === "terminal") {
    return {
      ...current,
      application: {
        ...current.application,
        terminalFontFamily: defaults.terminalFontFamily,
        terminalFontSize: defaults.terminalFontSize,
        terminalLineHeight: defaults.terminalLineHeight,
        terminalCursorStyle: defaults.terminalCursorStyle,
        terminalCursorBlink: defaults.terminalCursorBlink,
        terminalColorScheme: defaults.terminalColorScheme,
        multilinePasteConfirmation: defaults.multilinePasteConfirmation,
        copyOnSelect: defaults.copyOnSelect,
      },
    };
  }
  if (category === "connection") {
    return {
      ...current,
      application: {
        ...current.application,
        reconnectConfirmation: defaults.reconnectConfirmation,
      },
      connection: { ...DEFAULT_GLOBAL_CONNECTION_SETTINGS },
    };
  }
  if (category === "sftp") {
    return {
      ...current,
      application: {
        ...current.application,
        sftpDefaultLocalDirectory: defaults.sftpDefaultLocalDirectory,
        sftpConflictAction: defaults.sftpConflictAction,
      },
    };
  }
  if (category === "security") {
    return {
      ...current,
      application: {
        ...current.application,
        externalLinkConfirmation: defaults.externalLinkConfirmation,
        excludeCredentialsFromExport: defaults.excludeCredentialsFromExport,
      },
    };
  }
  if (category === "update") {
    return {
      ...current,
      application: {
        ...current.application,
        autoCheckUpdates: defaults.autoCheckUpdates,
      },
    };
  }
  if (category === "logs") {
    return {
      ...current,
      application: {
        ...current.application,
        logLevel: defaults.logLevel,
      },
    };
  }
  return current;
}

function SettingsSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <div className="settings-section-content">{children}</div>
    </section>
  );
}

function SettingsRow({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingNumber({
  disabled,
  min,
  unit,
  value,
  onChange,
}: {
  disabled: boolean;
  min: number;
  unit: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <div className="settings-number-with-unit">
      <InputNumber
        controls={false}
        disabled={disabled}
        max={4_294_967_295}
        min={min}
        value={value}
        onChange={(nextValue) => {
          if (nextValue !== null) onChange(nextValue);
        }}
      />
      <span>{unit}</span>
    </div>
  );
}

function ReadOnlyToggle({ label }: { label: string }) {
  return <Switch aria-label={label} checked disabled />;
}

function ShortcutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-shortcut-row">
      <span>{label}</span>
      <kbd>{value}</kbd>
    </div>
  );
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
