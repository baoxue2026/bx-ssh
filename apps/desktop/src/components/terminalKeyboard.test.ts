import { describe, expect, it } from "vitest";
import { shouldSkipApplicationShortcut } from "./terminalKeyboard";

describe("terminal keyboard ownership", () => {
  it.each(["a", "c", "1", "ArrowUp"])(
    "keeps unshifted Ctrl+%s inside the terminal",
    (key) => {
      const terminal = document.createElement("div");
      terminal.className = "terminal-container";
      const textarea = document.createElement("textarea");
      terminal.append(textarea);
      document.body.append(terminal);
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key,
      });
      textarea.dispatchEvent(event);

      expect(shouldSkipApplicationShortcut(event)).toBe(true);
      terminal.remove();
    },
  );

  it("allows shifted application shortcuts from the terminal", () => {
    const terminal = document.createElement("div");
    terminal.className = "terminal-container";
    document.body.append(terminal);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      shiftKey: true,
      key: "q",
    });
    terminal.dispatchEvent(event);

    expect(shouldSkipApplicationShortcut(event)).toBe(false);
    terminal.remove();
  });

  it("does not run application shortcuts during IME composition", () => {
    const event = new KeyboardEvent("keydown", {
      ctrlKey: true,
      key: "1",
    });
    Object.defineProperty(event, "isComposing", { value: true });

    expect(shouldSkipApplicationShortcut(event)).toBe(true);
  });
});
