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
  reset(): void;
  viewport(): TerminalViewport;
  write(data: Uint8Array, onProcessed?: () => void): void;
}

interface TerminalPaneProps {
  connected: boolean;
  onData(data: string): void;
  onResize(viewport: TerminalViewport): void;
}

export const TerminalPane = forwardRef<TerminalHandle, TerminalPaneProps>(
  function TerminalPane({ connected, onData, onResize }, ref) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const connectedRef = useRef(connected);
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);

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
          background: "#111418",
          foreground: "#d8dee7",
          cursor: "#f4f7fb",
          cursorAccent: "#111418",
          selectionBackground: "#355d8a99",
          black: "#1c2026",
          red: "#e06c75",
          green: "#8fca75",
          yellow: "#e5c07b",
          blue: "#61afef",
          magenta: "#c678dd",
          cyan: "#56b6c2",
          white: "#d8dee7",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      const emitResize = () => {
        fitAddon.fit();
        onResizeRef.current(viewportFor(terminal, container));
      };

      const frame = window.requestAnimationFrame(emitResize);
      const dataDisposable = terminal.onData((data) => {
        if (connectedRef.current) {
          onDataRef.current(data);
        }
      });
      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => emitResize());
      resizeObserver?.observe(container);

      return () => {
        window.cancelAnimationFrame(frame);
        resizeObserver?.disconnect();
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
