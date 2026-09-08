import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSecurityExceptions } from "./check-security-exceptions.mjs";

const today = "2026-09-08";
const config = (date = "2026-09-22") =>
  `[advisories]\nignore = [\n{ id = "RUSTSEC-2023-0071", reason = "Reviewed dependency; review before ${date}." },\n]\n[licenses]\nallow = ["MIT"]`;
const policy = (reviewBy = "2026-09-22") => ({
  knownExceptions: [
    {
      name: "test-only",
      versions: ["1.0.0"],
      license: "Unknown",
      scope: "development",
      reason: "Reviewed test dependency",
      reviewBy,
    },
  ],
});

describe("security exception expiry", () => {
  it("accepts reviewed Rust and npm exceptions before their deadlines", () => {
    assert.deepEqual(validateSecurityExceptions(config(), policy(), today), []);
  });
  it("blocks Rust exceptions on the deadline and afterwards", () => {
    for (const date of [today, "2026-09-03"])
      assert.match(
        validateSecurityExceptions(config(date), policy(), today).join("\n"),
        /reached its review date/,
      );
  });
  it("blocks npm license exceptions before the license inventory runs", () => {
    assert.match(
      validateSecurityExceptions(config(), policy(today), today).join("\n"),
      /npm license exception.*reached/,
    );
  });
  it("rejects missing and impossible review dates", () => {
    for (const date of ["not-set", "2026-02-30"])
      assert.match(
        validateSecurityExceptions(config(date), policy(), today).join("\n"),
        /no valid review date/,
      );
  });
  it("rejects duplicate Rust exceptions", () => {
    const duplicate = config().replace(
      "ignore = [",
      'ignore = [{ id = "RUSTSEC-2023-0071", reason = "Review before 2026-09-22." },',
    );
    assert.match(
      validateSecurityExceptions(duplicate, policy(), today).join("\n"),
      /Duplicate advisory exception/,
    );
  });
  it("does not silently skip malformed entries or a missing advisory section", () => {
    assert.match(
      validateSecurityExceptions(
        config().replace("id =", "identifier ="),
        policy(),
        today,
      ).join("\n"),
      /Unrecognized Rust advisory exception/,
    );
    assert.match(
      validateSecurityExceptions(
        "[licenses]\nallow = []",
        policy(),
        today,
      ).join("\n"),
      /Missing Rust advisory exception list/,
    );
  });
  it("accepts an explicitly empty exception list", () => {
    assert.deepEqual(
      validateSecurityExceptions(
        "[advisories]\nignore = []",
        { knownExceptions: [] },
        today,
      ),
      [],
    );
  });
  it("rejects incomplete npm exception records", () => {
    assert.match(
      validateSecurityExceptions(
        config(),
        { knownExceptions: [{}] },
        today,
      ).join("\n"),
      /Incomplete npm license exception/,
    );
  });
});
