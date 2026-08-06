import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import { MONOSPACE_FONT_STACK } from "../ui/fontStacks";

export interface TerminalViewport {
  columns: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface TerminalHandle {
  focus(): void;
  fit(): TerminalViewport;
  reset(): void;
  viewport(): TerminalViewport;
  write(data: Uint8Array, onProcessed?: () => void): void;
}

interface TerminalPaneProps {
  connected: boolean;
  sessionKey?: string;
  onData(data: string): void;
  onResize(viewport: TerminalViewport): void;
}

export const TerminalPane = forwardRef<TerminalHandle, TerminalPaneProps>(
  function TerminalPane({ connected, sessionKey, onData, onResize }, ref) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const connectedRef = useRef(connected);
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    const resizeFrameRef = useRef<number | null>(null);
    const disposedRef = useRef(false);

    useEffect(() => {
      connectedRef.current = connected;
    }, [connected]);

    useEffect(() => {
      onDataRef.current = onData;
      onResizeRef.current = onResize;
    }, [onData, onResize]);

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
        fontFamily: MONOSPACE_FONT_STACK,
        fontSize: 13,
        lineHeight: 1.15,
        scrollback: 100_000,
        theme: {
          background: "#0a0a0a",
          foreground: "#d6d6d6",
          cursor: "#d1faf5",
          cursorAccent: "#0a0a0a",
          selectionBackground: "#0d948899",
          black: "#151515",
          red: "#e06c75",
          green: "#8fca75",
          yellow: "#e5c07b",
          blue: "#5eead4",
          magenta: "#c678dd",
          cyan: "#5eead4",
          white: "#d6d6d6",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
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
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        dataDisposable.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
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
        reset() {
          terminalRef.current?.reset();
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
