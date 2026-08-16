import type { ITheme } from "@xterm/xterm";
import { MONOSPACE_FONT_STACK } from "../ui/fontStacks";

export type TerminalFontFamily = "cascadiaMono" | "cascadiaCode" | "consolas";
export type TerminalCursorStyle = "block" | "underline" | "bar";
export type TerminalColorScheme = "bxDark" | "solarizedDark" | "bxLight";

export interface TerminalAppearancePreferences {
  colorScheme: TerminalColorScheme;
  cursorBlink: boolean;
  cursorStyle: TerminalCursorStyle;
  fontFamily: TerminalFontFamily;
  fontSize: number;
}

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 20;

export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearancePreferences = {
  colorScheme: "bxDark",
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: "cascadiaMono",
  fontSize: 13,
};

export const TERMINAL_THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#d6d6d6",
  cursor: "#d1faf5",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#0d948899",
  selectionInactiveBackground: "#0d948855",
  black: "#151515",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d6d6d6",
  brightBlack: "#5c6370",
  brightRed: "#ff7a85",
  brightGreen: "#b4e88d",
  brightYellow: "#f2d18b",
  brightBlue: "#7ec7ff",
  brightMagenta: "#d99aee",
  brightCyan: "#70d7e2",
  brightWhite: "#ffffff",
};

export const TERMINAL_THEMES: Record<TerminalColorScheme, ITheme> = {
  bxDark: TERMINAL_THEME,
  solarizedDark: {
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#fdf6e3",
    cursorAccent: "#002b36",
    selectionBackground: "#268bd266",
    selectionInactiveBackground: "#268bd233",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#ff5f5f",
    brightGreen: "#a3be00",
    brightYellow: "#d7af00",
    brightBlue: "#5fafff",
    brightMagenta: "#ff5faf",
    brightCyan: "#5fd7d7",
    brightWhite: "#fdf6e3",
  },
  bxLight: {
    background: "#f7f7f7",
    foreground: "#24292f",
    cursor: "#0d9488",
    cursorAccent: "#f7f7f7",
    selectionBackground: "#0d948855",
    selectionInactiveBackground: "#0d94882e",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#d0d7de",
    brightBlack: "#57606a",
    brightRed: "#ff5a67",
    brightGreen: "#2da44e",
    brightYellow: "#bf8700",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#ffffff",
  },
};

export function terminalFontStack(fontFamily: TerminalFontFamily): string {
  if (fontFamily === "cascadiaCode") {
    return `"Cascadia Code", ${MONOSPACE_FONT_STACK}`;
  }
  if (fontFamily === "consolas") {
    return `Consolas, ${MONOSPACE_FONT_STACK}`;
  }
  return MONOSPACE_FONT_STACK;
}

export function terminalTheme(colorScheme: TerminalColorScheme): ITheme {
  return TERMINAL_THEMES[colorScheme];
}
