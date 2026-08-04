import { describe, expect, it } from "vitest";
import { isValidSshHost } from "./hostValidation";

describe("isValidSshHost", () => {
  it.each([
    "127.0.0.1",
    "192.168.1.10",
    "2001:db8::1",
    "::1",
    "server.example.com",
    "ssh-node-01.internal",
    "localhost",
  ])("accepts %s", (host) => {
    expect(isValidSshHost(host)).toBe(true);
  });

  it.each([
    "",
    " 127.0.0.1",
    "256.1.1.1",
    "1.2.3",
    "2001:db8::1::2",
    "[2001:db8::1]",
    "https://example.com",
    "example.com:22",
    "example.com/path",
    "bad host.example",
    "-node.example.com",
    "node-.example.com",
  ])("rejects %s", (host) => {
    expect(isValidSshHost(host)).toBe(false);
  });
});
