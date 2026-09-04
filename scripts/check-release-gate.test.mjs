import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  RELEASE_GATE_PATH,
  MATRIX_PATH,
  loadReviewedFiles,
  validateReleaseGateControls,
  validateReleasePolicy,
  validateReleaseReport,
} from "./check-release-gate.mjs";

function policy() {
  return JSON.parse(
    readFileSync(new URL(`../${RELEASE_GATE_PATH}`, import.meta.url), "utf8"),
  );
}

function validReport() {
  const suiteIds = policy().requiredSuites;
  return {
    schemaVersion: 1,
    version: "v1.0.0-rc.1",
    channel: "rc",
    tag: "v1.0.0-rc.1",
    commit: "0123456789abcdef0123456789abcdef01234567",
    sourceBranch: "main",
    generatedAt: "2026-09-04T10:00:00.000Z",
    tagVerification: {
      annotated: true,
      signed: true,
      immutable: true,
    },
    suites: suiteIds.map((id) => ({
      id,
      status: "pass",
      evidence: `artifacts/test-reports/${id.toLowerCase()}.json`,
    })),
    defects: {
      open: { P0: 0, P1: 0, P2: 1, P3: 0 },
      dispositions: { P2: "已登记下一修复版本" },
    },
    artifacts: [
      {
        platform: "windows-x64",
        type: "msi",
        path: "artifacts/release/v1.0.0-rc.1/windows-x64/bx-ssh.msi",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        signed: true,
        installerSigned: true,
        installerSignatureEvidence:
          "artifacts/release/v1.0.0-rc.1/windows-x64/windows-signature-report.json",
        signaturePath:
          "artifacts/release/v1.0.0-rc.1/windows-x64/bx-ssh.msi.sig",
        symbols: [
          "artifacts/release/v1.0.0-rc.1/windows-x64/symbols/bx-ssh.pdb",
        ],
      },
      {
        platform: "windows-x64",
        type: "nsis",
        path: "artifacts/release/v1.0.0-rc.1/windows-x64/bx-ssh.exe",
        sizeBytes: 2048,
        sha256: "b".repeat(64),
        signed: true,
        installerSigned: true,
        installerSignatureEvidence:
          "artifacts/release/v1.0.0-rc.1/windows-x64/windows-signature-report.json",
        signaturePath:
          "artifacts/release/v1.0.0-rc.1/windows-x64/bx-ssh.exe.sig",
        symbols: [
          "artifacts/release/v1.0.0-rc.1/windows-x64/symbols/bx-ssh.pdb",
        ],
      },
    ],
    sbom: {
      format: "CycloneDX",
      fileFormat: "json",
      path: "artifacts/sbom/v1.0.0-rc.1/bx-ssh.cdx.json",
      sha256: "c".repeat(64),
      retentionDays: 90,
      componentCounts: { "pkg:cargo/": 20, "pkg:npm/": 30 },
    },
    licenses: {
      rust: "pass",
      productionNpm: "pass",
      developmentNpm: "pass",
      audit: "pass",
      evidence: "artifacts/test-reports/license-report.json",
    },
    signatures: {
      installer: true,
      updater: true,
      tamperRejected: true,
      wrongKeyRejected: true,
      downgradeRejected: true,
      evidence: "artifacts/test-reports/update-validation.json",
    },
    reports: {
      tests: "artifacts/test-reports/tests.xml",
      bundleSizes: "artifacts/release/v1.0.0-rc.1/bundle-size.json",
      updateValidation: "artifacts/test-reports/update-validation.json",
      security: "artifacts/test-reports/security.json",
      stability: "artifacts/test-reports/stability.json",
      performance: "artifacts/test-reports/performance.json",
    },
    provenance: {
      workflow: "Release candidate",
      workflowRun: "https://github.com/baoxue2026/bx-ssh/actions/runs/123",
      repository: "baoxue2026/bx-ssh",
      runner: "windows-2025",
    },
    result: "pass",
  };
}

describe("phase-1 release gate policy", () => {
  it("accepts the versioned policy", () => {
    assert.deepEqual(validateReleasePolicy(policy()), []);
  });

  it("accepts the checked-in CI and packaging controls", () => {
    const violations = validateReleaseGateControls(loadReviewedFiles());
    assert.deepEqual(violations, []);
  });

  it("accepts a complete RC evidence report", () => {
    assert.deepEqual(validateReleaseReport(validReport(), policy()), []);
  });

  it("rejects a release with a mismatched channel or tag", () => {
    const report = validReport();
    report.channel = "stable";
    report.tag = "v1.0.0";
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /channel must be rc/);
    assert.match(violations, /tag must equal version/);
  });

  it("keeps the phase-one publication channel on RC tags", () => {
    const report = validReport();
    report.version = "v1.0.0";
    report.tag = "v1.0.0";
    report.channel = "stable";
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /RC tag pattern/);
    assert.match(violations, /channel must be rc/);
  });

  it("rejects a non-immutable or unsigned tag", () => {
    const report = validReport();
    report.tagVerification.signed = false;
    report.tagVerification.immutable = false;
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /tagVerification\.signed must be true/);
    assert.match(violations, /tagVerification\.immutable must be true/);
  });

  it("rejects open P0/P1 defects and missing dispositions", () => {
    const report = validReport();
    report.defects.open.P1 = 1;
    report.defects.open.P2 = 2;
    report.defects.dispositions.P2 = "";
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /defects\.open\.P1 exceeds/);
    assert.match(violations, /defects\.dispositions\.P2 is required/);
  });

  it("rejects an SBOM without both dependency ecosystems", () => {
    const report = validReport();
    report.sbom.componentCounts["pkg:npm/"] = 0;
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /pkg:npm\//);
  });

  it("rejects unsigned or path-traversing artifacts", () => {
    const report = validReport();
    report.artifacts[0].signed = false;
    report.artifacts[0].path = "artifacts/release/../secret.msi";
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /must be under artifacts\/release/);
    assert.match(violations, /must be signed/);
  });

  it("rejects a Windows installer without Authenticode evidence", () => {
    const report = validReport();
    delete report.artifacts[0].installerSigned;
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /valid Authenticode signature/);
  });

  it("rejects a suite that did not pass", () => {
    const report = validReport();
    report.suites[0].status = "failed";
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /QA-FUNC-01 must have pass status/);
  });

  it("rejects malformed provenance and commit identity", () => {
    const report = validReport();
    report.commit = "deadbeef";
    report.generatedAt = "not-a-timestamp";
    report.provenance.workflowRun = "";
    const violations = validateReleaseReport(report, policy()).join("\n");
    assert.match(violations, /commit must be a 40-character Git SHA/);
    assert.match(violations, /generatedAt must be a valid UTC timestamp/);
    assert.match(violations, /provenance\.workflowRun is required/);
  });

  it("rejects an unpinned action in the release workflow", () => {
    const files = loadReviewedFiles();
    files[".github/workflows/release.yml"] =
      `${files[".github/workflows/release.yml"]}\n      uses: actions/checkout@v4\n`;
    const violations = validateReleaseGateControls(files).join("\n");
    assert.match(violations, /contains an unpinned GitHub Action/);
  });

  it("requires every release job to use the verified tag commit", () => {
    const files = loadReviewedFiles();
    files[".github/workflows/release.yml"] = files[
      ".github/workflows/release.yml"
    ].replace(/\n\s+ref: \$\{\{ inputs\.version \|\| github\.ref \}\}/, "");
    const violations = validateReleaseGateControls(files).join("\n");
    assert.match(violations, /verified release tag in every job/);
  });

  it("requires collision-free release asset staging", () => {
    const files = loadReviewedFiles();
    files[".github/workflows/release.yml"] = files[
      ".github/workflows/release.yml"
    ].replace(
      /Stage uniquely named release assets[\s\S]*?      - name: Publish GitHub release/,
      "      - name: Publish GitHub release",
    );
    const violations = validateReleaseGateControls(files).join("\n");
    assert.match(violations, /collision-free release assets/);
  });

  it("rejects a missing release script", () => {
    const files = loadReviewedFiles();
    const packageJson = JSON.parse(files["package.json"]);
    delete packageJson.scripts["release:test"];
    files["package.json"] = JSON.stringify(packageJson);
    const violations = validateReleaseGateControls(files).join("\n");
    assert.match(violations, /package\.json release:test/);
  });

  it("keeps the policy and matrix paths explicit", () => {
    const files = loadReviewedFiles();
    const matrix = JSON.parse(files[MATRIX_PATH]);
    assert.equal(matrix.releaseGate.releasePolicy, RELEASE_GATE_PATH);
    assert.ok(files[".github/workflows/release.yml"].length > 0);
  });
});
