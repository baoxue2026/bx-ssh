import {
  DEFAULT_TERMINAL_APPEARANCE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type TerminalAppearancePreferences,
} from "../components/terminalAppearance";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type AppLanguage = "zh-CN" | "en-US";

export const THEME_STORAGE_KEY = "bx-ssh.theme-mode";
export const LANGUAGE_STORAGE_KEY = "bx-ssh.language";
export const TERMINAL_APPEARANCE_STORAGE_KEY = "bx-ssh.terminal-appearance";

export function readLanguage(): AppLanguage {
  const value = readPreference(LANGUAGE_STORAGE_KEY);
  return value === "en-US" ? value : "zh-CN";
}

export function readThemeMode(): ThemeMode {
  const value = readPreference(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "dark";
}

export function resolveTheme(
  themeMode: ThemeMode,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return themeMode === "system" ? systemTheme : themeMode;
}

export function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences remain active for the current process when storage is denied.
  }
}

export function readTerminalAppearance(): TerminalAppearancePreferences {
  const raw = readPreference(TERMINAL_APPEARANCE_STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_TERMINAL_APPEARANCE };
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return { ...DEFAULT_TERMINAL_APPEARANCE };
    }

    const stored = value as Partial<TerminalAppearancePreferences>;
    return {
      colorScheme:
        stored.colorScheme === "bxDark" ||
        stored.colorScheme === "solarizedDark" ||
        stored.colorScheme === "bxLight"
          ? stored.colorScheme
          : DEFAULT_TERMINAL_APPEARANCE.colorScheme,
      cursorBlink:
        typeof stored.cursorBlink === "boolean"
          ? stored.cursorBlink
          : DEFAULT_TERMINAL_APPEARANCE.cursorBlink,
      cursorStyle:
        stored.cursorStyle === "block" ||
        stored.cursorStyle === "underline" ||
        stored.cursorStyle === "bar"
          ? stored.cursorStyle
          : DEFAULT_TERMINAL_APPEARANCE.cursorStyle,
      fontFamily:
        stored.fontFamily === "cascadiaMono" ||
        stored.fontFamily === "cascadiaCode" ||
        stored.fontFamily === "consolas"
          ? stored.fontFamily
          : DEFAULT_TERMINAL_APPEARANCE.fontFamily,
      fontSize:
        typeof stored.fontSize === "number" &&
        Number.isInteger(stored.fontSize) &&
        stored.fontSize >= TERMINAL_FONT_SIZE_MIN &&
        stored.fontSize <= TERMINAL_FONT_SIZE_MAX
          ? stored.fontSize
          : DEFAULT_TERMINAL_APPEARANCE.fontSize,
      lineHeight:
        stored.lineHeight === "compact" ||
        stored.lineHeight === "standard" ||
        stored.lineHeight === "relaxed"
          ? stored.lineHeight
          : DEFAULT_TERMINAL_APPEARANCE.lineHeight,
    };
  } catch {
    return { ...DEFAULT_TERMINAL_APPEARANCE };
  }
}

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
