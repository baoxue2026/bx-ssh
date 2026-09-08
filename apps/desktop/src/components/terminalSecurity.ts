export const TERMINAL_PASTE_CONFIRM_LENGTH = 1_000;

export interface TerminalPasteDetails {
  characterCount: number;
  lineCount: number;
  requiresConfirmation: boolean;
}

export interface ExternalHttpLink {
  host: string;
  url: string;
}

export function terminalPasteDetails(text: string): TerminalPasteDetails {
  const hasLineBreak = /[\r\n]/.test(text);
  return {
    characterCount: text.length,
    lineCount: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length,
    requiresConfirmation:
      hasLineBreak || text.length > TERMINAL_PASTE_CONFIRM_LENGTH,
  };
}

export function parseExternalHttpLink(value: string): ExternalHttpLink | null {
  if (value.length === 0 || value.length > 2_048) return null;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    return { host: parsed.host, url: parsed.href };
  } catch {
    return null;
  }
}
