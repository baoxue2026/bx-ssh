import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadAcceptanceStatus,
  validateAcceptanceStatus,
} from "./check-acceptance-status.mjs";

describe("phase-1 acceptance status", () => {
  it("accepts the checked-in six-item status", () => {
    assert.deepEqual(validateAcceptanceStatus(loadAcceptanceStatus()), []);
  });

  it("rejects a ready report with pending items", () => {
    const status = structuredClone(loadAcceptanceStatus());
    status.releaseReadiness = "ready";
    const violations = validateAcceptanceStatus(status).join("\n");
    assert.match(violations, /cannot be ready/);
  });

  it("rejects an incomplete item list", () => {
    const status = structuredClone(loadAcceptanceStatus());
    status.items.pop();
    const violations = validateAcceptanceStatus(status).join("\n");
    assert.match(violations, /six unique tracked items/);
    assert.match(violations, /missing RELEASE-PROTECTION-01/);
  });

  it("rejects an implemented item with pending evidence", () => {
    const status = structuredClone(loadAcceptanceStatus());
    status.items[0].state = "implemented";
    const violations = validateAcceptanceStatus(status).join("\n");
    assert.match(
      violations,
      /cannot be implemented while pending evidence remains/,
    );
  });
});
