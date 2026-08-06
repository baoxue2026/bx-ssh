import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";

interface MockTerminalInstance {
  attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onSelectionChange: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  selection: string;
  write: ReturnType<typeof vi.fn>;
  emitData(data: string): void;
  emitSelection(): void;
  emitKey(event: KeyboardEvent): boolean | undefined;
}

interface MockFitAddonInstance {
  fit: ReturnType<typeof vi.fn>;
}

const xtermMocks = vi.hoisted(() => ({
  dataDisposables: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  fitAddons: [] as MockFitAddonInstance[],
  linkHandlers: [] as Array<(event: MouseEvent, url: string) => void>,
  selectionDisposables: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  terminals: [] as MockTerminalInstance[],
  terminalOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal implements MockTerminalInstance {
    clear = vi.fn();
    cols = 120;
    rows = 40;
    selection = "";
    dispose = vi.fn();
    focus = vi.fn();
    getSelection = vi.fn(() => this.selection);
    open = vi.fn();
    paste = vi.fn();
    reset = vi.fn();
    selectAll = vi.fn();
    write = vi.fn((_data: Uint8Array, onProcessed?: () => void) =>
      onProcessed?.(),
    );
    private dataHandler: ((data: string) => void) | null = null;
    private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    private selectionHandler: (() => void) | null = null;
    attachCustomKeyEventHandler = vi.fn(
      (handler: (event: KeyboardEvent) => boolean) => {
        this.keyHandler = handler;
      },
    );
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      const disposable = { dispose: vi.fn() };
      xtermMocks.dataDisposables.push(disposable);
      return disposable;
    });
    onSelectionChange = vi.fn((handler: () => void) => {
      this.selectionHandler = handler;
      const disposable = { dispose: vi.fn() };
      xtermMocks.selectionDisposables.push(disposable);
      return disposable;
    });

    constructor(options: Record<string, unknown>) {
      xtermMocks.terminals.push(this);
      xtermMocks.terminalOptions.push(options);
    }

    loadAddon() {}

    emitData(data: string) {
      this.dataHandler?.(data);
    }

    emitSelection() {
      this.selectionHandler?.();
    }

    emitKey(event: KeyboardEvent) {
      return this.keyHandler?.(event);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon implements MockFitAddonInstance {
    fit = vi.fn();

    constructor() {
      xtermMocks.fitAddons.push(this);
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    constructor(handler: (event: MouseEvent, url: string) => void) {
      xtermMocks.linkHandlers.push(handler);
    }
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

class MockResizeObserver implements ResizeObserver {
  static instances: MockResizeObserver[] = [];
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }

  emit() {
    this.callback([], this);
  }
}

describe("TerminalPane", () => {
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrame: number;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    xtermMocks.dataDisposables.length = 0;
    xtermMocks.fitAddons.length = 0;
    xtermMocks.linkHandlers.length = 0;
    xtermMocks.selectionDisposables.length = 0;
    xtermMocks.terminals.length = 0;
    xtermMocks.terminalOptions.length = 0;
    MockResizeObserver.instances.length = 0;
    animationFrames = new Map();
    nextAnimationFrame = 1;
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    originalResizeObserver = globalThis.ResizeObserver;
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextAnimationFrame++;
      animationFrames.set(id, callback);
      return id;
    });
    window.cancelAnimationFrame = vi.fn((id: number) => {
      animationFrames.delete(id);
    });
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    cleanup();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("coalesces resize work and reports the final viewport", () => {
    const onResize = vi.fn();
    const { container } = render(
      <TerminalPane
        connected
        sessionKey="session-1"
        onData={vi.fn()}
        onResize={onResize}
      />,
    );
    const terminalContainer = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(terminalContainer, {
      clientWidth: { configurable: true, value: 960 },
      clientHeight: { configurable: true, value: 600 },
    });
    act(() => flushAnimationFrames(animationFrames));
    onResize.mockClear();
    xtermMocks.fitAddons[0].fit.mockClear();

    const observer = MockResizeObserver.instances[0];
    observer.emit();
    observer.emit();
    expect(animationFrames).toHaveLength(1);

    act(() => flushAnimationFrames(animationFrames));

    expect(xtermMocks.fitAddons[0].fit).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith({
      columns: 120,
      rows: 40,
      pixelWidth: 960,
      pixelHeight: 600,
    });
    expect(terminalContainer).toHaveAttribute("data-session-key", "session-1");
  });

  it("uses current connection state and current callbacks", () => {
    const firstOnData = vi.fn();
    const latestOnData = vi.fn();
    const latestOnResize = vi.fn();
    const { rerender } = render(
      <TerminalPane
        connected={false}
        onData={firstOnData}
        onResize={vi.fn()}
      />,
    );
    const terminal = xtermMocks.terminals[0];

    terminal.emitData("blocked");
    rerender(
      <TerminalPane
        connected
        onData={latestOnData}
        onResize={latestOnResize}
      />,
    );
    terminal.emitData("中文输入\u001b[A");
    MockResizeObserver.instances[0].emit();
    act(() => flushAnimationFrames(animationFrames));

    expect(firstOnData).not.toHaveBeenCalled();
    expect(latestOnData).toHaveBeenCalledWith("中文输入\u001b[A");
    expect(latestOnResize).toHaveBeenCalledTimes(1);
  });

  it("focuses after connecting and cancels stale focus work", () => {
    const { rerender } = render(
      <TerminalPane
        connected={false}
        sessionKey="session-1"
        onData={vi.fn()}
        onResize={vi.fn()}
      />,
    );
    act(() => flushAnimationFrames(animationFrames));
    const terminal = xtermMocks.terminals[0];

    rerender(
      <TerminalPane
        connected
        sessionKey="session-1"
        onData={vi.fn()}
        onResize={vi.fn()}
      />,
    );
    expect(animationFrames).toHaveLength(1);
    rerender(
      <TerminalPane
        connected={false}
        sessionKey="session-1"
        onData={vi.fn()}
        onResize={vi.fn()}
      />,
    );
    act(() => flushAnimationFrames(animationFrames));
    expect(terminal.focus).not.toHaveBeenCalled();

    rerender(
      <TerminalPane
        connected
        sessionKey="session-2"
        onData={vi.fn()}
        onResize={vi.fn()}
      />,
    );
    act(() => flushAnimationFrames(animationFrames));
    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });

  it("handles selection, copy, paste and external links safely", () => {
    const onCopySelection = vi.fn();
    const onOpenLink = vi.fn();
    const onPasteRequest = vi.fn();
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <TerminalPane
        connected
        onCopySelection={onCopySelection}
        onData={vi.fn()}
        onOpenLink={onOpenLink}
        onPasteRequest={onPasteRequest}
        onResize={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );
    const terminal = xtermMocks.terminals[0];
    terminal.selection = "selected output";
    terminal.emitSelection();

    const copyEvent = new KeyboardEvent("keydown", {
      cancelable: true,
      ctrlKey: true,
      key: "c",
      shiftKey: true,
    });
    expect(terminal.emitKey(copyEvent)).toBe(false);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(onCopySelection).toHaveBeenCalledWith("selected output");

    const interruptEvent = new KeyboardEvent("keydown", {
      ctrlKey: true,
      key: "c",
    });
    expect(terminal.emitKey(interruptEvent)).toBe(true);
    expect(onCopySelection).toHaveBeenCalledTimes(1);

    const remoteSelectEvent = new KeyboardEvent("keydown", {
      ctrlKey: true,
      key: "a",
    });
    expect(terminal.emitKey(remoteSelectEvent)).toBe(true);
    expect(terminal.selectAll).not.toHaveBeenCalled();

    const pasteEvent = new KeyboardEvent("keydown", {
      cancelable: true,
      ctrlKey: true,
      key: "v",
      shiftKey: true,
    });
    expect(terminal.emitKey(pasteEvent)).toBe(false);
    expect(onPasteRequest).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith("selected output");

    rerender(
      <TerminalPane
        connected={false}
        onCopySelection={onCopySelection}
        onData={vi.fn()}
        onOpenLink={onOpenLink}
        onPasteRequest={onPasteRequest}
        onResize={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );
    terminal.emitKey(pasteEvent);
    expect(onPasteRequest).toHaveBeenCalledTimes(1);

    const linkEvent = new MouseEvent("click", { cancelable: true });
    xtermMocks.linkHandlers[0](linkEvent, "https://example.com/path");
    expect(linkEvent.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/path");
  });

  it("exposes terminal controls and releases every resource on unmount", () => {
    const ref = createRef<TerminalHandle>();
    const processed = vi.fn();
    const { unmount } = render(
      <TerminalPane ref={ref} connected onData={vi.fn()} onResize={vi.fn()} />,
    );
    const terminal = xtermMocks.terminals[0];
    const observer = MockResizeObserver.instances[0];

    ref.current?.clearScrollback();
    ref.current?.focus();
    ref.current?.reset();
    ref.current?.paste("pasted");
    ref.current?.selectAll();
    ref.current?.write(new Uint8Array([65]), processed);
    expect(ref.current?.fit()).toMatchObject({ columns: 120, rows: 40 });

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.focus).toHaveBeenCalledTimes(1);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(terminal.paste).toHaveBeenCalledWith("pasted");
    expect(terminal.selectAll).toHaveBeenCalledTimes(1);
    expect(xtermMocks.terminalOptions[0]).toMatchObject({
      scrollback: 100_000,
    });
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(processed).toHaveBeenCalledTimes(1);

    unmount();

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(xtermMocks.dataDisposables[0].dispose).toHaveBeenCalledTimes(1);
    expect(xtermMocks.selectionDisposables[0].dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(animationFrames).toHaveLength(0);
  });

  it("refits after the application returns to the foreground", () => {
    const onResize = vi.fn();
    render(<TerminalPane connected onData={vi.fn()} onResize={onResize} />);
    act(() => flushAnimationFrames(animationFrames));
    onResize.mockClear();
    xtermMocks.fitAddons[0].fit.mockClear();

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animationFrames).toHaveLength(1);
    act(() => flushAnimationFrames(animationFrames));

    expect(xtermMocks.fitAddons[0].fit).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledTimes(1);
  });
});

function flushAnimationFrames(frames: Map<number, FrameRequestCallback>) {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
