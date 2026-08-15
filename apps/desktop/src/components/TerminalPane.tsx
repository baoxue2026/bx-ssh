import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button, Input, Tooltip, type InputRef } from "antd";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, X } from "lucide-react";
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
  openSearch(): void;
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

type SearchDirection = "next" | "previous";

interface SearchResult {
  resultCount: number;
  resultIndex: number;
}

const EMPTY_SEARCH_RESULT: SearchResult = {
  resultCount: 0,
  resultIndex: -1,
};

const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  activeMatchBackground: "#b8860b",
  activeMatchBorder: "#ffe58f",
  activeMatchColorOverviewRuler: "#fff566",
  matchBackground: "#665c00",
  matchBorder: "#d4b106",
  matchOverviewRuler: "#d4b106",
};

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
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const searchInputRef = useRef<InputRef>(null);
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
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchRegex, setSearchRegex] = useState(false);
    const [searchResult, setSearchResult] =
      useState<SearchResult>(EMPTY_SEARCH_RESULT);
    const [searchError, setSearchError] = useState<
      "invalidRegex" | undefined
    >();

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
      const searchAddon = new SearchAddon();
      const webLinksAddon = new WebLinksAddon((event, url) => {
        event.preventDefault();
        onOpenLinkRef.current?.(url);
      });
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(container);
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

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
      const searchResultsDisposable = searchAddon.onDidChangeResults(
        ({ resultIndex, resultCount }) => {
          if (!disposedRef.current) {
            setSearchResult({ resultIndex, resultCount });
          }
        },
      );
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
        if (key === "f") {
          event.preventDefault();
          setSearchOpen(true);
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
        searchResultsDisposable.dispose();
        searchAddon.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
      };
    }, []);

    const runSearch = useCallback(
      (direction: SearchDirection, incremental = false) => {
        const searchAddon = searchAddonRef.current;
        if (!searchAddon || !searchQuery) {
          searchAddon?.clearDecorations();
          setSearchResult(EMPTY_SEARCH_RESULT);
          setSearchError(undefined);
          return;
        }

        if (searchRegex) {
          try {
            new RegExp(searchQuery, searchCaseSensitive ? undefined : "i");
          } catch {
            searchAddon.clearDecorations();
            setSearchResult(EMPTY_SEARCH_RESULT);
            setSearchError("invalidRegex");
            return;
          }
        }

        setSearchError(undefined);
        const options: ISearchOptions = {
          caseSensitive: searchCaseSensitive,
          decorations: SEARCH_DECORATIONS,
          incremental: direction === "next" && incremental,
          regex: searchRegex,
        };
        const found =
          direction === "next"
            ? searchAddon.findNext(searchQuery, options)
            : searchAddon.findPrevious(searchQuery, options);
        if (!found) {
          searchAddon.clearDecorations();
          setSearchResult(EMPTY_SEARCH_RESULT);
        }
      },
      [searchCaseSensitive, searchQuery, searchRegex],
    );

    useEffect(() => {
      if (searchOpen) {
        searchInputRef.current?.focus();
        runSearch("next", true);
      }
    }, [runSearch, searchOpen]);

    const closeSearch = useCallback(() => {
      searchAddonRef.current?.clearDecorations();
      setSearchOpen(false);
      setSearchResult(EMPTY_SEARCH_RESULT);
      setSearchError(undefined);
      terminalRef.current?.focus();
    }, []);

    const openSearch = useCallback(() => {
      setSearchOpen(true);
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
        openSearch,
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
      [openSearch],
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
        className="terminal-container"
        data-session-key={sessionKey}
        role="application"
        aria-label={t("terminal.aria")}
      >
        <div ref={containerRef} className="terminal-surface" />
        {searchOpen && (
          <div
            aria-label={t("terminal.search.label")}
            className="terminal-search-panel"
            role="search"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
          >
            <Input
              ref={searchInputRef}
              aria-label={t("terminal.search.input")}
              className="terminal-search-input"
              placeholder={t("terminal.search.placeholder")}
              status={searchError ? "error" : undefined}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onPressEnter={(event) => {
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
              }}
            />
            <span
              aria-live="polite"
              className={`terminal-search-status${searchError ? " is-error" : ""}`}
              role="status"
            >
              {searchError
                ? t("terminal.search.invalidRegex")
                : searchResult.resultCount > 0
                  ? t("terminal.search.results", {
                      current: searchResult.resultIndex + 1,
                      total: searchResult.resultCount,
                    })
                  : searchQuery
                    ? t("terminal.search.noResults")
                    : null}
            </span>
            <div className="terminal-search-actions">
              <Tooltip title={t("terminal.search.caseSensitive")}>
                <Button
                  aria-label={t("terminal.search.caseSensitive")}
                  aria-pressed={searchCaseSensitive}
                  className={
                    searchCaseSensitive
                      ? "terminal-search-toggle is-active"
                      : "terminal-search-toggle"
                  }
                  size="small"
                  type="text"
                  onClick={() => setSearchCaseSensitive((value) => !value)}
                >
                  Aa
                </Button>
              </Tooltip>
              <Tooltip title={t("terminal.search.regex")}>
                <Button
                  aria-label={t("terminal.search.regex")}
                  aria-pressed={searchRegex}
                  className={
                    searchRegex
                      ? "terminal-search-toggle is-active"
                      : "terminal-search-toggle"
                  }
                  size="small"
                  type="text"
                  onClick={() => setSearchRegex((value) => !value)}
                >
                  .*
                </Button>
              </Tooltip>
              <Tooltip title={t("terminal.search.previous")}>
                <Button
                  aria-label={t("terminal.search.previous")}
                  disabled={!searchQuery || Boolean(searchError)}
                  icon={<ChevronUp size={14} />}
                  size="small"
                  type="text"
                  onClick={() => runSearch("previous")}
                />
              </Tooltip>
              <Tooltip title={t("terminal.search.next")}>
                <Button
                  aria-label={t("terminal.search.next")}
                  disabled={!searchQuery || Boolean(searchError)}
                  icon={<ChevronDown size={14} />}
                  size="small"
                  type="text"
                  onClick={() => runSearch("next")}
                />
              </Tooltip>
              <Tooltip title={t("terminal.search.close")}>
                <Button
                  aria-label={t("terminal.search.close")}
                  icon={<X size={14} />}
                  size="small"
                  type="text"
                  onClick={closeSearch}
                />
              </Tooltip>
            </div>
          </div>
        )}
      </div>
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
