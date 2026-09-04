import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  STABILITY_BUDGET_PATH,
  loadReviewedFiles,
  loadStabilityBudget,
  validateStabilityBudget,
  validateStabilityControls,
  validateStabilityReport,
} from "./check-stability-controls.mjs";

const stabilityBudget = loadStabilityBudget();
const checkerPath = fileURLToPath(
  new URL("./check-stability-controls.mjs", import.meta.url),
);
const validReport = {
  schemaVersion: 1,
  generatedAt: "2026-09-04T00:00:00.000Z",
  commit: "current-commit",
  baselineCommit: "previous-release",
  runId: "win11-stability-2026-09-04",
  result: "pass",
  processScope: "all-related-processes",
  measurementMethod:
    "Windows process counters, lifecycle event log, and fixed fault-injection scenarios",
  durationHours: 24,
  environment: {
    platform: "Windows",
    os: "Windows 11 24H2",
    architecture: "x64",
    cpuCores: 4,
    memoryGb: 16,
    storage: "NVMe",
  },
  scenarioCounts: {
    terminalSessions: 5,
    sftpSessions: 1,
    sleepWake: 3,
    networkDisconnect: 10,
    reconnect: 10,
    sftpCancellation: 10,
  },
  sampleCounts: {
    workingSet: 1440,
    state: 1440,
    handleSnapshots: 24,
  },
  measurements: {
    steadyStateWorkingSetMb: 200,
    finalWorkingSetMb: 220,
    peakWorkingSetMb: 260,
    workingSetGrowthRatio: 0.1,
    steadyStateWarmupMinutes: 30,
    networkOutageSeconds: 30,
    postCleanupObservationMinutes: 10,
    leakedSessionHandles: 0,
    leakedTransferHandles: 0,
    falseConnectedStates: 0,
    staleHandleOperationsAccepted: 0,
    unhandledFailures: 0,
    sleepWakeStateAccurate: true,
    networkDisconnectStateAccurate: true,
    reconnectUsedFreshSessionIds: true,
    terminalAndSftpIsolationPreserved: true,
    cleanupCompleted: true,
  },
  evidence: {
    processMemory: "artifacts/stability/process-memory.csv",
    lifecycleEvents: "artifacts/stability/lifecycle-events.jsonl",
    faultTimeline: "artifacts/stability/fault-timeline.jsonl",
    handleSnapshots: "artifacts/stability/handle-snapshots.jsonl",
    failureSummary: "artifacts/stability/failure-summary.json",
  },
};

describe("phase-1 stability controls", () => {
  it("accepts the reviewed stability budget", () => {
    assert.deepEqual(validateStabilityBudget(stabilityBudget), []);
  });

  it("accepts the implementation lifecycle controls", () => {
    assert.deepEqual(validateStabilityControls(loadReviewedFiles()), []);
  });

  it("requires the Windows raw evidence collector", () => {
    const files = loadReviewedFiles();
    files["scripts/collect-windows-stability.ps1"] = "";
    const violations = validateStabilityControls(files).join("\n");
    assert.match(violations, /raw evidence collector is missing/);
  });

  it("rejects a lifecycle implementation without terminal transport observation", () => {
    const files = loadReviewedFiles();
    files["apps/desktop/src-tauri/src/terminal.rs"] = files[
      "apps/desktop/src-tauri/src/terminal.rs"
    ].replace("session.wait_for_transport()", "pending_transport()");

    assert.ok(
      validateStabilityControls(files).some((violation) =>
        violation.includes("transport-failure observation"),
      ),
    );
  });

  it("rejects a stability budget without a 24-hour soak", () => {
    const budget = structuredClone(stabilityBudget);
    budget.thresholds.soakDurationHours.min = 0;

    assert.ok(
      validateStabilityBudget(budget).some((violation) =>
        violation.includes("soakDurationHours"),
      ),
    );
  });

  it("rejects a budget that disables baseline commit tracking", () => {
    const budget = structuredClone(stabilityBudget);
    budget.protocol.baselineCommitRequired = false;

    assert.ok(
      validateStabilityBudget(budget).some((violation) =>
        violation.includes("baselineCommitRequired"),
      ),
    );
  });

  it("accepts a report that meets every stability gate", () => {
    assert.deepEqual(validateStabilityReport(validReport), []);
  });

  it("rejects a soak shorter than 24 hours", () => {
    assert.ok(
      validateStabilityReport({ ...validReport, durationHours: 23.99 }).some(
        (violation) => violation.includes("durationHours"),
      ),
    );
  });

  it("rejects working-set growth over 15 percent", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          finalWorkingSetMb: 232,
          workingSetGrowthRatio: 0.16,
        },
      }).some((violation) => violation.includes("workingSetGrowthRatio")),
    );
  });

  it("rejects a reported memory ratio that disagrees with raw values", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          workingSetGrowthRatio: 0.01,
        },
      }).some((violation) => violation.includes("must match")),
    );
  });

  it("rejects a report that compares a commit with itself", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        baselineCommit: validReport.commit,
      }).some((violation) => violation.includes("different revisions")),
    );
  });

  it("allows working set to fall below the steady-state baseline", () => {
    assert.deepEqual(
      validateStabilityReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          finalWorkingSetMb: 180,
          workingSetGrowthRatio: -0.1,
        },
      }),
      [],
    );
  });

  it("rejects leaked session and transfer handles", () => {
    const violations = validateStabilityReport({
      ...validReport,
      measurements: {
        ...validReport.measurements,
        leakedSessionHandles: 1,
        leakedTransferHandles: 2,
      },
    }).join("\n");

    assert.match(violations, /leakedSessionHandles/);
    assert.match(violations, /leakedTransferHandles/);
  });

  it("rejects false connected states and accepted stale handles", () => {
    const violations = validateStabilityReport({
      ...validReport,
      measurements: {
        ...validReport.measurements,
        falseConnectedStates: 1,
        staleHandleOperationsAccepted: 1,
      },
    }).join("\n");

    assert.match(violations, /falseConnectedStates/);
    assert.match(violations, /staleHandleOperationsAccepted/);
  });

  it("rejects insufficient fault-injection cycles", () => {
    const violations = validateStabilityReport({
      ...validReport,
      scenarioCounts: {
        ...validReport.scenarioCounts,
        sleepWake: 1,
        networkDisconnect: 1,
      },
    }).join("\n");

    assert.match(violations, /scenarioCounts\.sleepWake/);
    assert.match(violations, /scenarioCounts\.networkDisconnect/);
  });

  it("rejects insufficient observations", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        sampleCounts: { ...validReport.sampleCounts, workingSet: 10 },
      }).some((violation) => violation.includes("sampleCounts.workingSet")),
    );
  });

  it("rejects a fault run without the required outage and cleanup observations", () => {
    const violations = validateStabilityReport({
      ...validReport,
      measurements: {
        ...validReport.measurements,
        networkOutageSeconds: 5,
        postCleanupObservationMinutes: 1,
      },
    }).join("\n");

    assert.match(violations, /measurements\.networkOutageSeconds/);
    assert.match(violations, /measurements\.postCleanupObservationMinutes/);
  });

  it("rejects reconnects that reuse a stale session identifier", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        measurements: {
          ...validReport.measurements,
          reconnectUsedFreshSessionIds: false,
        },
      }).some((violation) =>
        violation.includes("reconnectUsedFreshSessionIds"),
      ),
    );
  });

  it("rejects evidence outside the stability artifact directory", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        evidence: { ...validReport.evidence, processMemory: "memory.csv" },
      }).some((violation) => violation.includes("evidence.processMemory")),
    );
  });

  it("rejects a report measured on a different reference environment", () => {
    assert.ok(
      validateStabilityReport({
        ...validReport,
        environment: { ...validReport.environment, memoryGb: 32 },
      }).some((violation) => violation.includes("environment.memoryGb")),
    );
  });

  it("rejects a control set with a malformed budget", () => {
    const files = loadReviewedFiles();
    files[STABILITY_BUDGET_PATH] = "{";

    assert.ok(
      validateStabilityControls(files).some((violation) =>
        violation.includes("valid JSON"),
      ),
    );
  });

  it("reports a malformed matrix without throwing", () => {
    const files = loadReviewedFiles();
    files["quality/phase-1-test-matrix.json"] = JSON.stringify({
      testSuites: [null],
    });

    assert.ok(
      validateStabilityControls(files).some((violation) =>
        violation.includes("QA-STAB-01"),
      ),
    );
  });

  it("validates a report through the command-line entry point", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bx-ssh-stability-"));
    const reportPath = path.join(directory, "report.json");
    try {
      writeFileSync(reportPath, JSON.stringify(validReport));
      const result = spawnSync(
        process.execPath,
        [checkerPath, "--report", reportPath],
        { encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Stability controls and report passed/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
