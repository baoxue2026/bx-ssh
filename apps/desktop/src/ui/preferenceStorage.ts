export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type AppLanguage = "zh-CN" | "en-US";

export const THEME_STORAGE_KEY = "bx-ssh.theme-mode";
export const LANGUAGE_STORAGE_KEY = "bx-ssh.language";

export function readLanguage(): AppLanguage {
  const value = readPreference(LANGUAGE_STORAGE_KEY);
  return value === "en-US" ? value : "zh-CN";
}

export function readThemeMode(): ThemeMode {
  const value = readPreference(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
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

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
