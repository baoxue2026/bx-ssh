import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { DEFAULT_TERMINAL_APPEARANCE } from "../components/terminalAppearance";
import {
  LANGUAGE_STORAGE_KEY,
  TERMINAL_APPEARANCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  readLanguage,
  readTerminalAppearance,
  readThemeMode,
} from "./preferenceStorage";
import { useUiPreferences } from "./preferenceContext";
import { UiPreferencesProvider } from "./preferences";

describe("UI preferences", () => {
  beforeEach(async () => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeMode;
    document.documentElement.style.colorScheme = "";
    document.documentElement.lang = "zh-CN";
    installMatchMedia(false);
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("falls back safely when stored preferences are missing or invalid", () => {
    expect(readThemeMode()).toBe("dark");
    expect(readLanguage()).toBe("zh-CN");
    expect(readTerminalAppearance()).toEqual(DEFAULT_TERMINAL_APPEARANCE);

    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr-FR");
    localStorage.setItem(
      TERMINAL_APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        colorScheme: "neon",
        cursorBlink: "yes",
        cursorStyle: "square",
        fontFamily: "remoteFont",
        fontSize: 99,
      }),
    );

    expect(readThemeMode()).toBe("dark");
    expect(readLanguage()).toBe("zh-CN");
    expect(readTerminalAppearance()).toEqual(DEFAULT_TERMINAL_APPEARANCE);
  });

  it("persists runtime theme and language changes", async () => {
    renderPreferences();

    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-mode", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => {
      expect(screen.getByTestId("translated-heading")).toHaveTextContent(
        "Connection Verification",
      );
    });
    expect(document.documentElement.lang).toBe("en-US");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en-US");

    fireEvent.click(screen.getByRole("button", { name: "Terminal 16" }));
    expect(
      JSON.parse(
        localStorage.getItem(TERMINAL_APPEARANCE_STORAGE_KEY) ?? "null",
      ),
    ).toEqual({
      ...DEFAULT_TERMINAL_APPEARANCE,
      fontFamily: "consolas",
      fontSize: 16,
    });
  });

  it("tracks operating-system theme changes in system mode", async () => {
    const media = installMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    renderPreferences();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute(
      "data-theme-mode",
      "system",
    );

    media.setMatches(true);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    expect(document.documentElement).toHaveAttribute(
      "data-theme-mode",
      "system",
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("restores persisted preferences on mount", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en-US");
    localStorage.setItem(
      TERMINAL_APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_TERMINAL_APPEARANCE,
        colorScheme: "solarizedDark",
        cursorStyle: "bar",
        fontSize: 15,
      }),
    );

    renderPreferences();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-mode", "dark");
    expect(document.documentElement.lang).toBe("en-US");
    expect(await screen.findByTestId("translated-heading")).toHaveTextContent(
      "Connection Verification",
    );
    expect(screen.getByTestId("terminal-appearance")).toHaveTextContent(
      "15 bar solarizedDark",
    );
  });
});

function PreferencesProbe() {
  const {
    setLanguage,
    setTerminalAppearance,
    setThemeMode,
    terminalAppearance,
  } = useUiPreferences();
  const { t } = useTranslation();

  return (
    <>
      <span data-testid="translated-heading">{t("connection.title")}</span>
      <span data-testid="terminal-appearance">
        {terminalAppearance.fontSize} {terminalAppearance.cursorStyle}{" "}
        {terminalAppearance.colorScheme}
      </span>
      <button type="button" onClick={() => setThemeMode("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setLanguage("en-US")}>
        English
      </button>
      <button
        type="button"
        onClick={() =>
          setTerminalAppearance({
            ...terminalAppearance,
            fontFamily: "consolas",
            fontSize: 16,
          })
        }
      >
        Terminal 16
      </button>
    </>
  );
}

function renderPreferences() {
  return render(
    <UiPreferencesProvider>
      <PreferencesProbe />
    </UiPreferencesProvider>,
  );
}

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    ),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: this.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return media;
}
