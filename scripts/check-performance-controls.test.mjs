import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadReviewedFiles,
  loadPerformanceBudget,
  validatePerformanceControls,
  validatePerformanceBudget,
  validatePerformanceReport,
} from "./check-performance-controls.mjs";

const performanceBudget = loadPerformanceBudget();
const checkerPath = fileURLToPath(
  new URL("./check-performance-controls.mjs", import.meta.url),
);
const validReport = {
  schemaVersion: 1,
  generatedAt: "2026-09-03T00:00:00.000Z",
  commit: "current-commit",
  baselineCommit: "previous-release",
  result: "pass",
  processScope: "all-related-processes",
  measurementMethod: "Windows Performance Recorder and fixed scenario script",
  sessionCount: 10,
  environment: {
    platform: "Windows",
    os: "Windows 11 24H2",
    architecture: "x64",
    cpuCores: 4,
    memoryGb: 16,
    storage: "NVMe",
  },
  sampleCounts: {
    startup: 10,
    trayRestore: 10,
    idleWorkingSet: 12,
    tenSessionWorkingSet: 12,
    tabSwitch: 100,
    terminalOutput: 1,
    sftp: 1,
  },
  measurements: {
    coldStartP95Ms: 2_000,
    trayRestoreP95Ms: 1_000,
    idleWorkingSetMb: 100,
    tenSessionWorkingSetMb: 220,
    tabSwitchP95Ms: 80,
    terminalOutputBytesPerSecond: 2 * 1024 * 1024,
    terminalOutputDurationSeconds: 300,
    sftpBytes: 1024 * 1024 * 1024,
    sftpBytesPerSecond: 8_500_000,
    sftpBaselineBytesPerSecond: 10_000_000,
    terminalUiResponsive: true,
    terminalMemoryRecovered: true,
    sftpSpeedRatio: 0.85,
    sftpSha256Match: true,
  },
};

describe("phase-1 performance controls", () => {
  it("accepts the reviewed performance budget", () => {
    assert.deepEqual(validatePerformanceBudget(performanceBudget), []);
  });

  it("accepts the implementation controls", () => {
    assert.deepEqual(validatePerformanceControls(loadReviewedFiles()), []);
  });

  it("rejects a performance budget with a missing threshold", () => {
    const files = loadReviewedFiles();
    const budgetPath = "quality/phase-1-performance-budget.json";
    const budget = JSON.parse(files[budgetPath]);
    delete budget.thresholds.sftpSpeedRatio;
    files[budgetPath] = JSON.stringify(budget);

    assert.ok(
      validatePerformanceControls(files).some((violation) =>
        violation.includes("sftpSpeedRatio"),
      ),
    );
  });

  it("accepts a report that meets the phase-1 budgets", () => {
    assert.deepEqual(validatePerformanceReport(validReport), []);
  });

  it("rejects a report that does not exercise ten sessions", () => {
    assert.ok(
      validatePerformanceReport({ ...validReport, sessionCount: 5 }).some(
        (violation) => violation.includes("sessionCount"),
      ),
    );
  });

  it("rejects a report that exceeds the cold-start budget", () => {
    assert.ok(
      validatePerformanceReport({
        ...validReport,
        measurements: { ...validReport.measurements, coldStartP95Ms: 2_501 },
      }).some((violation) => violation.includes("coldStartP95Ms")),
    );
  });

  it("records tray restore without inventing an undocumented release limit", () => {
    assert.deepEqual(
      validatePerformanceReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          trayRestoreP95Ms: 10_000,
        },
      }),
      [],
    );
  });

  it("rejects an SFTP run without an integrity match", () => {
    assert.ok(
      validatePerformanceReport({
        ...validReport,
        measurements: { ...validReport.measurements, sftpSha256Match: false },
      }).some((violation) => violation.includes("sftpSha256Match")),
    );
  });

  it("rejects an SFTP run smaller than the one-gibibyte scenario", () => {
    assert.ok(
      validatePerformanceReport({
        ...validReport,
        measurements: { ...validReport.measurements, sftpBytes: 1 },
      }).some((violation) => violation.includes("sftpBytes")),
    );
  });

  it("rejects a report with insufficient fixed-protocol samples", () => {
    assert.ok(
      validatePerformanceReport({
        ...validReport,
        sampleCounts: { ...validReport.sampleCounts, tabSwitch: 1 },
      }).some((violation) => violation.includes("sampleCounts.tabSwitch")),
    );
  });

  it("rejects a budget that removes the baseline requirement", () => {
    const budget = structuredClone(performanceBudget);
    budget.protocol.baselineCommitRequired = false;
    assert.ok(
      validatePerformanceBudget(budget).some((violation) =>
        violation.includes("baselineCommitRequired"),
      ),
    );
  });

  it("rejects an SFTP ratio that does not match the raw rates", () => {
    assert.ok(
      validatePerformanceReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          sftpSpeedRatio: 0.95,
        },
      }).some((violation) => violation.includes("must match")),
    );
  });

  it("rejects missing raw SFTP comparison rates", () => {
    assert.ok(
      validatePerformanceReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          sftpBaselineBytesPerSecond: 0,
        },
      }).some((violation) => violation.includes("must be positive")),
    );
  });

  it("validates a report through the command-line entry point", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bx-ssh-performance-"));
    const reportPath = path.join(directory, "report.json");
    try {
      writeFileSync(reportPath, JSON.stringify(validReport));
      const result = spawnSync(
        process.execPath,
        [checkerPath, "--report", reportPath],
        { encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Performance controls and report passed/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
