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
import {
  LANGUAGE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  readLanguage,
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

    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr-FR");

    expect(readThemeMode()).toBe("dark");
    expect(readLanguage()).toBe("zh-CN");
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

    renderPreferences();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-mode", "dark");
    expect(document.documentElement.lang).toBe("en-US");
    expect(await screen.findByTestId("translated-heading")).toHaveTextContent(
      "Connection Verification",
    );
  });
});

function PreferencesProbe() {
  const { setLanguage, setThemeMode } = useUiPreferences();
  const { t } = useTranslation();

  return (
    <>
      <span data-testid="translated-heading">{t("connection.title")}</span>
      <button type="button" onClick={() => setThemeMode("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setLanguage("en-US")}>
        English
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
