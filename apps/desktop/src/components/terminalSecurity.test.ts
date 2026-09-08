import { describe, expect, it } from "vitest";
import {
  parseExternalHttpLink,
  terminalPasteDetails,
} from "./terminalSecurity";

describe("terminal paste confirmation", () => {
  it("allows short single-line text without confirmation", () => {
    expect(terminalPasteDetails("git status")).toEqual({
      characterCount: 10,
      lineCount: 1,
      requiresConfirmation: false,
    });
  });

  it.each(["first\nsecond", "first\rsecond", "first\r\nsecond"])(
    "requires confirmation for multiline text",
    (text) => {
      expect(terminalPasteDetails(text)).toMatchObject({
        lineCount: 2,
        requiresConfirmation: true,
      });
    },
  );

  it("requires confirmation for a long single line", () => {
    expect(terminalPasteDetails("x".repeat(1_001))).toMatchObject({
      lineCount: 1,
      requiresConfirmation: true,
    });
  });
});

describe("external terminal links", () => {
  it("normalizes HTTP links and exposes the complete host", () => {
    expect(
      parseExternalHttpLink("https://docs.example.com:8443/a path?q=1"),
    ).toEqual({
      host: "docs.example.com:8443",
      url: "https://docs.example.com:8443/a%20path?q=1",
    });
  });

  it.each([
    "javascript:alert(1)",
    "file:///C:/secret.txt",
    "https://user:secret@example.com/",
    "not a url",
  ])("rejects unsafe external value %s", (value) => {
    expect(parseExternalHttpLink(value)).toBeNull();
  });
});
