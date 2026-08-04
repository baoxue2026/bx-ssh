import { createContext, useContext } from "react";
import type {
  AppLanguage,
  ResolvedTheme,
  ThemeMode,
} from "./preferenceStorage";

export interface UiPreferences {
  language: AppLanguage;
  resolvedTheme: ResolvedTheme;
  setLanguage(language: AppLanguage): void;
  setThemeMode(themeMode: ThemeMode): void;
  themeMode: ThemeMode;
}

export const UiPreferencesContext = createContext<UiPreferences | null>(null);

export function useUiPreferences(): UiPreferences {
  const value = useContext(UiPreferencesContext);
  if (!value) {
    throw new Error(
      "useUiPreferences must be used within UiPreferencesProvider",
    );
  }
  return value;
}
