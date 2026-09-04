import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePolicy } from "./check-qa-policy.mjs";

const validSuite = {
  id: "QA-FUNC-01",
  category: "functional",
  name: "功能测试",
  owner: "仓库维护者",
  blocking: "release",
  environments: [
    {
      id: "win11",
      platform: "Windows",
      os: "Windows 11",
      architecture: "x64",
      purpose: "验收",
    },
  ],
  commands: [{ run: "pnpm test", type: "automated" }],
  manualChecks: ["手工检查"],
  artifacts: ["CI logs"],
};

function policyWith(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: "P1",
    title: "一期",
    owner: "仓库维护者",
    primaryPlatform: "Windows",
    releaseGate: {
      rule: "blocking suite must pass",
      evidenceRequired: true,
      defectLevelsBlockingRelease: ["P0", "P1"],
    },
    defectSeverity: [
      {
        id: "P0",
        name: "紧急",
        description: "安全",
        releaseBlocking: true,
        responseTarget: "立即",
      },
      {
        id: "P1",
        name: "严重",
        description: "核心",
        releaseBlocking: true,
        responseTarget: "当前迭代",
      },
      {
        id: "P2",
        name: "一般",
        description: "重要",
        releaseBlocking: false,
        responseTarget: "排期",
      },
      {
        id: "P3",
        name: "轻微",
        description: "体验",
        releaseBlocking: false,
        responseTarget: "维护",
      },
    ],
    testSuites: [
      validSuite,
      { ...validSuite, id: "QA-COMP-01", category: "compatibility" },
      { ...validSuite, id: "QA-PERF-01", category: "performance" },
      { ...validSuite, id: "QA-STAB-01", category: "stability" },
      { ...validSuite, id: "QA-SEC-01", category: "security" },
      { ...validSuite, id: "QA-INSTALL-01", category: "installation" },
      { ...validSuite, id: "QA-RECOVERY-01", category: "recovery" },
      { ...validSuite, id: "QA-REL-01", category: "release" },
    ],
    ...overrides,
  };
}

describe("phase-1 QA policy", () => {
  it("accepts a complete policy", () => {
    assert.deepEqual(validatePolicy(policyWith()), []);
  });

  it("rejects a missing test category", () => {
    const policy = policyWith({
      testSuites: policyWith().testSuites.filter(
        (suite) => suite.category !== "stability",
      ),
    });
    assert.match(
      validatePolicy(policy).join("\n"),
      /must define exactly one stability test suite/,
    );
  });

  it("rejects an invalid defect severity", () => {
    const policy = policyWith({
      defectSeverity: policyWith().defectSeverity.map((severity) =>
        severity.id === "P2" ? { ...severity, id: "P4" } : severity,
      ),
    });
    assert.match(validatePolicy(policy).join("\n"), /invalid severity id/);
  });

  it("rejects a release-blocking suite without an environment", () => {
    const policy = policyWith({
      testSuites: policyWith().testSuites.map((suite) =>
        suite.category === "security" ? { ...suite, environments: [] } : suite,
      ),
    });
    assert.match(
      validatePolicy(policy).join("\n"),
      /must define at least one environment/,
    );
  });

  it("rejects a suite without an owner", () => {
    const policy = policyWith({
      testSuites: policyWith().testSuites.map((suite) =>
        suite.category === "functional" ? { ...suite, owner: "" } : suite,
      ),
    });
    assert.match(
      validatePolicy(policy).join("\n"),
      /Test suite QA-FUNC-01 owner must be a non-empty string/,
    );
  });

  it("accepts registered PowerShell automation scripts", () => {
    const policy = policyWith({
      testSuites: policyWith().testSuites.map((suite) =>
        suite.category === "compatibility"
          ? {
              ...suite,
              commands: [
                {
                  run: "pwsh scripts/test-openssh-windows.ps1 -MatrixId windows-server-2025-ed25519 -HostKeyAlgorithm ed25519",
                  type: "automated",
                },
              ],
            }
          : suite,
      ),
    });

    assert.deepEqual(validatePolicy(policy), []);
  });
});
