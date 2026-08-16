import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_THEMES, terminalFontStack } from "./terminalAppearance";

const terminals: Terminal[] = [];

afterEach(() => {
  terminals.splice(0).forEach((terminal) => terminal.dispose());
});

describe("terminal compatibility", () => {
  it("keeps all 16 configured ANSI colors distinct", () => {
    for (const theme of Object.values(TERMINAL_THEMES)) {
      const colors = [
        theme.black,
        theme.red,
        theme.green,
        theme.yellow,
        theme.blue,
        theme.magenta,
        theme.cyan,
        theme.white,
        theme.brightBlack,
        theme.brightRed,
        theme.brightGreen,
        theme.brightYellow,
        theme.brightBlue,
        theme.brightMagenta,
        theme.brightCyan,
        theme.brightWhite,
      ];

      expect(colors.every((color) => /^#[0-9a-f]{6}$/i.test(color ?? ""))).toBe(
        true,
      );
      expect(new Set(colors)).toHaveLength(16);
    }
  });

  it("keeps an offline monospace fallback for every font choice", () => {
    expect(terminalFontStack("cascadiaMono")).toContain("Cascadia Mono");
    expect(terminalFontStack("cascadiaCode")).toContain("Cascadia Code");
    expect(terminalFontStack("consolas")).toContain("Consolas");
    expect(terminalFontStack("cascadiaCode")).toContain("monospace");
    expect(terminalFontStack("consolas")).toContain("monospace");
  });

  it("parses ANSI, 256-color and True Color sequences", async () => {
    const terminal = createTerminal();
    await writeTerminal(
      terminal,
      "\u001b[31mR\u001b[38;5;202mP\u001b[38;2;12;34;56mT\u001b[0mD",
    );
    const line = terminal.buffer.active.getLine(0);
    const ansi = line?.getCell(0);
    const palette = line?.getCell(1);
    const trueColor = line?.getCell(2);
    const reset = line?.getCell(3);

    expect(ansi?.isFgPalette()).toBe(true);
    expect(ansi?.getFgColor()).toBe(1);
    expect(palette?.isFgPalette()).toBe(true);
    expect(palette?.getFgColor()).toBe(202);
    expect(trueColor?.isFgRGB()).toBe(true);
    expect(trueColor?.getFgColor()).toBe(0x0c2238);
    expect(reset?.isFgDefault()).toBe(true);
  });

  it("decodes split UTF-8 and preserves wide and combining cells", async () => {
    const terminal = createTerminal();
    const bytes = new TextEncoder().encode("A中界😀e\u0301");

    await writeBytes(terminal, bytes.slice(0, 3));
    await writeBytes(terminal, bytes.slice(3, 7));
    await writeBytes(terminal, bytes.slice(7));

    const line = terminal.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe("A中界😀e\u0301");
    expect(line?.getCell(0)?.getWidth()).toBe(1);
    expect(line?.getCell(1)?.getChars()).toBe("中");
    expect(line?.getCell(1)?.getWidth()).toBe(2);
    expect(line?.getCell(2)?.getWidth()).toBe(0);
    expect(line?.getCell(3)?.getChars()).toBe("界");
    expect(line?.getCell(3)?.getWidth()).toBe(2);
    expect(line?.getCell(4)?.getWidth()).toBe(0);
    expect(line?.getCell(5)?.getChars()).toBe("😀");
    const finalCell = line?.getCell(terminal.buffer.active.cursorX - 1);
    expect(finalCell?.getChars()).toBe("e\u0301");
    expect(finalCell?.getWidth()).toBe(1);
  });
});

function createTerminal() {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  terminals.push(terminal);
  return terminal;
}

function writeTerminal(terminal: Terminal, data: string) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

function writeBytes(terminal: Terminal, data: Uint8Array) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}
