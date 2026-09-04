import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMainBranchProtection } from "./check-main-branch-protection.mjs";

function validProtection() {
  return {
    required_status_checks: {
      strict: true,
      checks: [{ context: "Release gate", app_id: -1 }],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
    },
    required_linear_history: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

describe("main branch protection validator", () => {
  it("accepts the required protected-branch policy", () => {
    assert.deepEqual(validateMainBranchProtection(validProtection()), []);
  });

  it("accepts the legacy contexts response shape", () => {
    const protection = validProtection();
    protection.required_status_checks = {
      strict: true,
      contexts: ["Release gate"],
    };
    assert.deepEqual(validateMainBranchProtection(protection), []);
  });

  it("rejects missing status checks and reviews", () => {
    const protection = validProtection();
    protection.required_status_checks = null;
    protection.required_pull_request_reviews = null;
    const violations = validateMainBranchProtection(protection).join("\n");
    assert.match(violations, /require status checks/);
    assert.match(violations, /require pull-request reviews/);
  });

  it("rejects weak review and administrator settings", () => {
    const protection = validProtection();
    protection.required_pull_request_reviews.required_approving_review_count = 0;
    protection.required_pull_request_reviews.dismiss_stale_reviews = false;
    protection.enforce_admins.enabled = false;
    const violations = validateMainBranchProtection(protection).join("\n");
    assert.match(violations, /at least one approval/);
    assert.match(violations, /dismiss stale approvals/);
    assert.match(violations, /protect administrators/);
  });

  it("rejects branch destruction and non-linear history", () => {
    const protection = validProtection();
    protection.required_linear_history.enabled = false;
    protection.allow_force_pushes.enabled = true;
    protection.allow_deletions.enabled = true;
    const violations = validateMainBranchProtection(protection).join("\n");
    assert.match(violations, /require linear history/);
    assert.match(violations, /disable force pushes/);
    assert.match(violations, /disable branch deletion/);
  });

  it("rejects a policy without the required Release gate check", () => {
    const protection = validProtection();
    protection.required_status_checks.checks = [{ context: "Frontend checks" }];
    const violations = validateMainBranchProtection(protection).join("\n");
    assert.match(violations, /must require the Release gate status check/);
  });
});
