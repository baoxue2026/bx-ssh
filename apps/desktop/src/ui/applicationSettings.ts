import type {
  ApplicationSettings,
  ConnectionSettings,
  GlobalSettingsSnapshot,
} from "../ipc/bindings";
import type { TerminalAppearancePreferences } from "../components/terminalAppearance";
import type { AppLanguage, ThemeMode } from "./preferenceStorage";

export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  version: 1,
  language: "zh-CN",
  themeMode: "dark",
  confirmClose: true,
  defaultGroupId: null,
  compactLayout: false,
  terminalFontFamily: "cascadiaMono",
  terminalFontSize: 13,
  terminalLineHeight: "standard",
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  terminalColorScheme: "bxDark",
  multilinePasteConfirmation: true,
  copyOnSelect: false,
  reconnectConfirmation: true,
  sftpDefaultLocalDirectory: null,
  sftpConflictAction: "ask",
  externalLinkConfirmation: true,
  excludeCredentialsFromExport: true,
  autoCheckUpdates: true,
  logLevel: "info",
};

export const DEFAULT_GLOBAL_CONNECTION_SETTINGS: ConnectionSettings = {
  connectTimeoutSecs: 10,
  keepAliveSecs: 30,
};

export function initialGlobalSettings(
  language: AppLanguage,
  themeMode: ThemeMode,
  terminalAppearance: TerminalAppearancePreferences,
): GlobalSettingsSnapshot {
  return {
    application: {
      ...DEFAULT_APPLICATION_SETTINGS,
      language,
      themeMode,
      terminalColorScheme: terminalAppearance.colorScheme,
      terminalCursorBlink: terminalAppearance.cursorBlink,
      terminalCursorStyle: terminalAppearance.cursorStyle,
      terminalFontFamily: terminalAppearance.fontFamily,
      terminalFontSize: terminalAppearance.fontSize,
      terminalLineHeight: terminalAppearance.lineHeight,
    },
    applicationInitialized: false,
    connection: { ...DEFAULT_GLOBAL_CONNECTION_SETTINGS },
  };
}

export function terminalAppearanceFromSettings(
  settings: ApplicationSettings,
): TerminalAppearancePreferences {
  return {
    colorScheme: settings.terminalColorScheme,
    cursorBlink: settings.terminalCursorBlink,
    cursorStyle: settings.terminalCursorStyle,
    fontFamily: settings.terminalFontFamily,
    fontSize: settings.terminalFontSize,
    lineHeight: settings.terminalLineHeight,
  };
}
