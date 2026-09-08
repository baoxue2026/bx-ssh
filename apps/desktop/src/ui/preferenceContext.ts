import { createContext, useContext } from "react";
import type {
  AppLanguage,
  ResolvedTheme,
  ThemeMode,
} from "./preferenceStorage";
import type { TerminalAppearancePreferences } from "../components/terminalAppearance";

export interface UiPreferences {
  language: AppLanguage;
  resolvedTheme: ResolvedTheme;
  setTerminalAppearance(appearance: TerminalAppearancePreferences): void;
  setLanguage(language: AppLanguage): void;
  setThemeMode(themeMode: ThemeMode): void;
  terminalAppearance: TerminalAppearancePreferences;
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
