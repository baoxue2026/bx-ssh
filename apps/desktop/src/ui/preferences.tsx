import { useEffect, useMemo, useState, type ReactNode } from "react";
import i18n from "../i18n";
import {
  LANGUAGE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  readLanguage,
  readThemeMode,
  resolveTheme,
  writePreference,
  type AppLanguage,
  type ResolvedTheme,
  type ThemeMode,
} from "./preferenceStorage";
import { UiPreferencesContext, type UiPreferences } from "./preferenceContext";

const DARK_THEME_QUERY = "(prefers-color-scheme: dark)";

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [language, setLanguage] = useState<AppLanguage>(readLanguage);
  const [systemTheme, setSystemTheme] =
    useState<ResolvedTheme>(readSystemTheme);
  const resolvedTheme = resolveTheme(themeMode, systemTheme);

  useEffect(() => {
    const media = window.matchMedia?.(DARK_THEME_QUERY);
    if (!media) return;

    const updateSystemTheme = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", updateSystemTheme);
    return () => media.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    applyDocumentPreferences(themeMode, resolvedTheme, language);
    writePreference(THEME_STORAGE_KEY, themeMode);
    writePreference(LANGUAGE_STORAGE_KEY, language);
    if (i18n.resolvedLanguage !== language) {
      void i18n.changeLanguage(language);
    }
  }, [language, resolvedTheme, themeMode]);

  const value = useMemo<UiPreferences>(
    () => ({
      language,
      resolvedTheme,
      setLanguage,
      setThemeMode,
      themeMode,
    }),
    [language, resolvedTheme, themeMode],
  );

  return (
    <UiPreferencesContext.Provider value={value}>
      {children}
    </UiPreferencesContext.Provider>
  );
}

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia?.(DARK_THEME_QUERY).matches ? "dark" : "light";
}

function applyDocumentPreferences(
  themeMode: ThemeMode,
  resolvedTheme: ResolvedTheme,
  language: AppLanguage,
) {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = themeMode;
  root.style.colorScheme = resolvedTheme;
  root.lang = language;
}
