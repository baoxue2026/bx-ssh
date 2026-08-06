import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import { MONOSPACE_FONT_STACK } from "../ui/fontStacks";
import { TERMINAL_THEME } from "./terminalAppearance";

export interface TerminalViewport {
  columns: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface TerminalHandle {
  clearScrollback(): void;
  focus(): void;
  fit(): TerminalViewport;
  getSelection(): string;
  paste(data: string): void;
  reset(): void;
  selectAll(): void;
  viewport(): TerminalViewport;
  write(data: Uint8Array, onProcessed?: () => void): void;
}

interface TerminalPaneProps {
  connected: boolean;
  sessionKey?: string;
  onData(data: string): void;
  onCopySelection?(data: string): void;
  onOpenLink?(url: string): void;
  onPasteRequest?(): void;
  onResize(viewport: TerminalViewport): void;
  onSelectionChange?(data: string): void;
}

export const TerminalPane = forwardRef<TerminalHandle, TerminalPaneProps>(
  function TerminalPane(
    {
      connected,
      sessionKey,
      onCopySelection,
      onData,
      onOpenLink,
      onPasteRequest,
      onResize,
      onSelectionChange,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const connectedRef = useRef(connected);
    const onCopySelectionRef = useRef(onCopySelection);
    const onDataRef = useRef(onData);
    const onOpenLinkRef = useRef(onOpenLink);
    const onPasteRequestRef = useRef(onPasteRequest);
    const onResizeRef = useRef(onResize);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const resizeFrameRef = useRef<number | null>(null);
    const focusFrameRef = useRef<number | null>(null);
    const disposedRef = useRef(false);

    useEffect(() => {
      connectedRef.current = connected;
    }, [connected]);

    useEffect(() => {
      onCopySelectionRef.current = onCopySelection;
      onDataRef.current = onData;
      onOpenLinkRef.current = onOpenLink;
      onPasteRequestRef.current = onPasteRequest;
      onResizeRef.current = onResize;
      onSelectionChangeRef.current = onSelectionChange;
    }, [
      onCopySelection,
      onData,
      onOpenLink,
      onPasteRequest,
      onResize,
      onSelectionChange,
    ]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      disposedRef.current = false;

      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "block",
        drawBoldTextInBrightColors: true,
        fontFamily: MONOSPACE_FONT_STACK,
        fontSize: 13,
        lineHeight: 1.15,
        minimumContrastRatio: 1,
        scrollback: 100_000,
        theme: TERMINAL_THEME,
      });
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon((event, url) => {
        event.preventDefault();
        onOpenLinkRef.current?.(url);
      });
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(container);
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      const emitResize = () => {
        if (disposedRef.current) return;
        fitAddon.fit();
        onResizeRef.current(viewportFor(terminal, container));
      };

      const scheduleResize = () => {
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          emitResize();
        });
      };

      scheduleResize();
      const dataDisposable = terminal.onData((data) => {
        if (connectedRef.current) {
          onDataRef.current(data);
        }
      });
      const selectionDisposable = terminal.onSelectionChange(() => {
        onSelectionChangeRef.current?.(terminal.getSelection());
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          event.type !== "keydown" ||
          !event.ctrlKey ||
          !event.shiftKey ||
          event.altKey ||
          event.metaKey
        ) {
          return true;
        }

        const key = event.key.toLowerCase();
        if (key === "c") {
          event.preventDefault();
          const selection = terminal.getSelection();
          if (selection) onCopySelectionRef.current?.(selection);
          return false;
        }
        if (key === "v") {
          event.preventDefault();
          if (connectedRef.current) onPasteRequestRef.current?.();
          return false;
        }
        return true;
      });
      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(scheduleResize);
      resizeObserver?.observe(container);

      const handleVisibilityChange = () => {
        if (!document.hidden) scheduleResize();
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      return () => {
        disposedRef.current = true;
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        resizeObserver?.disconnect();
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
        dataDisposable.dispose();
        selectionDisposable.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        clearScrollback() {
          terminalRef.current?.clear();
        },
        focus() {
          terminalRef.current?.focus();
        },
        fit() {
          const terminal = terminalRef.current;
          const container = containerRef.current;
          const fitAddon = fitAddonRef.current;
          if (terminal && container && fitAddon) {
            fitAddon.fit();
            return viewportFor(terminal, container);
          }
          return { columns: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 };
        },
        getSelection() {
          return terminalRef.current?.getSelection() ?? "";
        },
        paste(data: string) {
          terminalRef.current?.paste(data);
        },
        reset() {
          terminalRef.current?.reset();
        },
        selectAll() {
          terminalRef.current?.selectAll();
        },
        viewport() {
          const terminal = terminalRef.current;
          const container = containerRef.current;
          return terminal && container
            ? viewportFor(terminal, container)
            : { columns: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 };
        },
        write(data: Uint8Array, onProcessed?: () => void) {
          const terminal = terminalRef.current;
          if (terminal) {
            terminal.write(data, onProcessed);
          } else {
            onProcessed?.();
          }
        },
      }),
      [],
    );

    useEffect(() => {
      if (!connected) return;

      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        if (!disposedRef.current) terminalRef.current?.focus();
      });

      return () => {
        if (focusFrameRef.current !== null) {
          window.cancelAnimationFrame(focusFrameRef.current);
          focusFrameRef.current = null;
        }
      };
    }, [connected, sessionKey]);

    return (
      <div
        ref={containerRef}
        className="terminal-container"
        data-session-key={sessionKey}
        role="application"
        aria-label={t("terminal.aria")}
      />
    );
  },
);

function viewportFor(
  terminal: Terminal,
  container: HTMLDivElement,
): TerminalViewport {
  return {
    columns: Math.max(terminal.cols, 1),
    rows: Math.max(terminal.rows, 1),
    pixelWidth: Math.max(container.clientWidth, 0),
    pixelHeight: Math.max(container.clientHeight, 0),
  };
}
