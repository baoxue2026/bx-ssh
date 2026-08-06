import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_THEME } from "./terminalAppearance";

const terminals: Terminal[] = [];

afterEach(() => {
  terminals.splice(0).forEach((terminal) => terminal.dispose());
});

describe("terminal compatibility", () => {
  it("keeps all 16 configured ANSI colors distinct", () => {
    const colors = [
      TERMINAL_THEME.black,
      TERMINAL_THEME.red,
      TERMINAL_THEME.green,
      TERMINAL_THEME.yellow,
      TERMINAL_THEME.blue,
      TERMINAL_THEME.magenta,
      TERMINAL_THEME.cyan,
      TERMINAL_THEME.white,
      TERMINAL_THEME.brightBlack,
      TERMINAL_THEME.brightRed,
      TERMINAL_THEME.brightGreen,
      TERMINAL_THEME.brightYellow,
      TERMINAL_THEME.brightBlue,
      TERMINAL_THEME.brightMagenta,
      TERMINAL_THEME.brightCyan,
      TERMINAL_THEME.brightWhite,
    ];

    expect(colors.every((color) => /^#[0-9a-f]{6}$/i.test(color ?? ""))).toBe(
      true,
    );
    expect(new Set(colors)).toHaveLength(16);
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
