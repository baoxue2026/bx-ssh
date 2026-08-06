import { useState, type ReactNode } from "react";
import { Button, Input, InputNumber, Select } from "antd";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Keyboard,
  Key,
  Palette,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareTerminal,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConnectionGroup } from "../ipc/bindings";
import { useUiPreferences } from "../ui/preferenceContext";

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
  groups: ConnectionGroup[];
  left: number;
  version: string;
  onCheckForUpdates(): void;
  onClose(): void;
}

const categories: Array<{
  icon: LucideIcon;
  id: SettingsCategory;
}> = [
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
  groups,
  left,
  version,
  onCheckForUpdates,
  onClose,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<SettingsCategory>("general");
  const preferences = useUiPreferences();

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
            <SettingsContent
              active={active}
              appName={appName}
              groups={groups}
              version={version}
              onCheckForUpdates={onCheckForUpdates}
              preferences={preferences}
            />
          </div>
        </main>
      </div>
    </section>
  );
}

function SettingsContent({
  active,
  appName,
  groups,
  version,
  onCheckForUpdates,
  preferences,
}: {
  active: SettingsCategory;
  appName: string;
  groups: ConnectionGroup[];
  version: string;
  onCheckForUpdates(): void;
  preferences: ReturnType<typeof useUiPreferences>;
}) {
  const { t } = useTranslation();

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
              value={preferences.language}
              options={[
                {
                  label: t("appearance.languageChinese"),
                  value: "zh-CN",
                },
                {
                  label: t("appearance.languageEnglish"),
                  value: "en-US",
                },
              ]}
              onChange={preferences.setLanguage}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.confirmClose")}
            description={t("settings.descriptions.confirmClose")}
          >
            <ReadOnlyToggle label={t("settings.rows.confirmClose")} />
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
              className="settings-control is-readonly"
              disabled
              value="ungrouped"
              options={[
                {
                  label: t("settings.values.ungrouped"),
                  value: "ungrouped",
                },
                ...groups.map((group) => ({
                  label: group.name,
                  value: group.id,
                })),
              ]}
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
              className={`settings-theme-option${preferences.themeMode === themeMode ? " is-active" : ""}`}
              key={themeMode}
              type="button"
              role="radio"
              aria-checked={preferences.themeMode === themeMode}
              onClick={() => preferences.setThemeMode(themeMode)}
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
          <ReadOnlyToggle label={t("settings.rows.compactLayout")} />
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
              className="settings-control is-readonly"
              disabled
              value="Cascadia Mono"
              options={[{ label: "Cascadia Mono", value: "Cascadia Mono" }]}
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
              disabled
              value={13}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.terminalLineHeight")}
            description={t("settings.descriptions.terminalLineHeight")}
          >
            <Select
              aria-label={t("settings.rows.terminalLineHeight")}
              className="settings-control is-readonly"
              disabled
              value="standard"
              options={[
                { label: t("settings.values.standard"), value: "standard" },
              ]}
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.input")}>
          <SettingsRow
            title={t("settings.rows.multilinePaste")}
            description={t("settings.descriptions.multilinePaste")}
          >
            <ReadOnlyToggle label={t("settings.rows.multilinePaste")} />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.copyOnSelect")}
            description={t("settings.descriptions.copyOnSelect")}
          >
            <ReadOnlyToggle
              label={t("settings.rows.copyOnSelect")}
              checked={false}
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
          <SettingNumber value={10} unit={t("settings.units.seconds")} />
        </SettingsRow>
        <SettingsRow
          title={t("settings.rows.keepAlive")}
          description={t("settings.descriptions.keepAlive")}
        >
          <SettingNumber value={30} unit={t("settings.units.seconds")} />
        </SettingsRow>
        <SettingsRow
          title={t("settings.rows.reconnectConfirm")}
          description={t("settings.descriptions.reconnectConfirm")}
        >
          <ReadOnlyToggle label={t("settings.rows.reconnectConfirm")} />
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
                disabled
                placeholder={t("settings.values.systemDefault")}
              />
              <Button disabled icon={<FolderOpen size={13} />}>
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
              className="settings-control is-readonly"
              disabled
              value="ask"
              options={[
                { label: t("settings.values.askEveryTime"), value: "ask" },
              ]}
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
            <ReadOnlyToggle label={t("settings.rows.externalLinkConfirm")} />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.excludeCredentials")}
            description={t("settings.descriptions.excludeCredentials")}
          >
            <ReadOnlyToggle label={t("settings.rows.excludeCredentials")} />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title={t("settings.sections.sshKeys")}>
          <Button disabled icon={<Key size={13} />}>
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
          <ReadOnlyToggle label={t("settings.rows.autoUpdate")} />
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
            className="settings-control is-readonly"
            disabled
            value="info"
            options={[{ label: t("settings.values.info"), value: "info" }]}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings.sections.diagnostics")}>
        <div className="settings-button-row">
          <Button disabled icon={<ExternalLink size={13} />}>
            {t("settings.actions.openLogDirectory")}
          </Button>
          <Button disabled type="primary" icon={<Download size={13} />}>
            {t("settings.actions.exportDiagnostics")}
          </Button>
        </div>
      </SettingsSection>
    </>
  );
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

function SettingNumber({ value, unit }: { value: number; unit: string }) {
  return (
    <div className="settings-number-with-unit">
      <InputNumber controls={false} disabled value={value} />
      <span>{unit}</span>
    </div>
  );
}

function ReadOnlyToggle({
  checked = true,
  label,
}: {
  checked?: boolean;
  label: string;
}) {
  return (
    <button
      aria-checked={checked}
      aria-disabled="true"
      aria-label={label}
      className={`settings-toggle${checked ? " is-checked" : ""}`}
      disabled
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
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
