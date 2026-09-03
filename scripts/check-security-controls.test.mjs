import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loadReviewedFiles,
  validateSecurityControls,
} from "./check-security-controls.mjs";

describe("phase-1 security controls", () => {
  it("accepts the reviewed credential, fingerprint, path, log, and boundary controls", () => {
    assert.deepEqual(validateSecurityControls(loadReviewedFiles()), []);
  });

  it("rejects a wildcard command permission", () => {
    const files = loadReviewedFiles();
    files["apps/desktop/src-tauri/permissions/main.toml"] = files[
      "apps/desktop/src-tauri/permissions/main.toml"
    ].replace('"app_info"', '"*"');

    assert.ok(
      validateSecurityControls(files).some((violation) =>
        violation.includes("wildcard"),
      ),
    );
  });

  it("rejects sensitive fields added to connection contracts", () => {
    const files = loadReviewedFiles();
    files["crates/contracts/src/connection.rs"] += "\npub password: String;\n";

    assert.ok(
      validateSecurityControls(files).some((violation) =>
        violation.includes("credential or private-key material"),
      ),
    );
  });
});
