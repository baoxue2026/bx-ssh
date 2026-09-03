import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const STABILITY_BUDGET_PATH = "quality/phase-1-stability-budget.json";

const reviewedPaths = [
  "apps/desktop/src/App.tsx",
  "apps/desktop/src-tauri/src/lifecycle.rs",
  "apps/desktop/src-tauri/src/session_manager.rs",
  "apps/desktop/src-tauri/src/sftp.rs",
  "apps/desktop/src-tauri/src/terminal.rs",
  "crates/ssh-core/src/session.rs",
  "package.json",
  STABILITY_BUDGET_PATH,
  "quality/phase-1-test-matrix.json",
];

export function loadStabilityBudget(root = workspace) {
  return JSON.parse(
    readFileSync(path.join(root, STABILITY_BUDGET_PATH), "utf8"),
  );
}

export function loadReviewedFiles(root = workspace) {
  return Object.fromEntries(
    reviewedPaths.map((relativePath) => [
      relativePath,
      readFileSync(path.join(root, relativePath), "utf8"),
    ]),
  );
}

export function validateStabilityControls(files) {
  const violations = [];
  const source = (relativePath) => files[relativePath] ?? "";

  const sessionManager = source(
    "apps/desktop/src-tauri/src/session_manager.rs",
  );
  for (const [pattern, description] of [
    [/attempts\.remove\(attempt_id\)/, "connection-attempt removal"],
    [/attempt\.cancellation\.cancel\(\)/, "pending-attempt cancellation"],
    [/sessions\.remove\(session_id\)/, "managed-session removal"],
    [/inner\.attempts\.clear\(\)/, "attempt-map cleanup"],
    [/inner\.sessions\.clear\(\)/, "session-map cleanup"],
  ]) {
    if (!pattern.test(sessionManager)) {
      violations.push(`session manager is missing ${description}`);
    }
  }

  const terminal = source("apps/desktop/src-tauri/src/terminal.rs");
  for (const [pattern, description] of [
    [/session\.wait_for_transport\(\)/, "transport-failure observation"],
    [
      /manager\.sessions\s*\.lock\(\)\.await\s*\.remove\(&session_id\)/,
      "terminal worker removal",
    ],
    [
      /session_manager\.remove_session\(&session_id, SessionKind::Terminal\)/,
      "terminal state removal",
    ],
    [/session\.disconnect\(\)\.await/, "transport disconnect cleanup"],
    [
      /pub\(crate\) async fn close_all[\s\S]*?\.drain\(\)/,
      "close-all draining",
    ],
    [/manager\.activity\.track_session\(\)/, "session activity tracking"],
  ]) {
    if (!pattern.test(terminal)) {
      violations.push(`terminal lifecycle is missing ${description}`);
    }
  }

  const sftp = source("apps/desktop/src-tauri/src/sftp.rs");
  for (const [pattern, description] of [
    [
      /cancel_session_transfers\(&session_id\)\.await/,
      "session transfer cancellation",
    ],
    [
      /async fn finish_transfer\(&self, transfer_id:/,
      "transfer-map completion",
    ],
    [
      /self\.transfers\.lock\(\)\.await\.remove\(transfer_id\)/,
      "transfer removal",
    ],
    [
      /pub\(crate\) async fn close_all[\s\S]*?cancel_all_transfers\(\)\.await[\s\S]*?\.drain\(\)/,
      "SFTP close-all draining",
    ],
    [/ssh\.disconnect\(\)\.await/, "SFTP transport disconnect cleanup"],
    [/_activity_guard: ActivityGuard/, "SFTP activity guard ownership"],
  ]) {
    if (!pattern.test(sftp)) {
      violations.push(`SFTP lifecycle is missing ${description}`);
    }
  }

  const lifecycle = source("apps/desktop/src-tauri/src/lifecycle.rs");
  for (const [pattern, description] of [
    [
      /tokio::join!\(terminal_manager\.close_all\(\), sftp_manager\.close_all\(\)\)/,
      "parallel terminal and SFTP shutdown",
    ],
    [/timeout\(EXIT_CLEANUP_TIMEOUT, cleanup\)/, "bounded shutdown timeout"],
    [
      /session_manager\.clear\(\)/,
      "connection-attempt and session invalidation",
    ],
  ]) {
    if (!pattern.test(lifecycle)) {
      violations.push(`application lifecycle is missing ${description}`);
    }
  }

  const coreSession = source("crates/ssh-core/src/session.rs");
  for (const [pattern, description] of [
    [/keepalive_interval:/, "configured SSH keepalive"],
    [/keepalive_max:\s*3/, "bounded keepalive failure detection"],
    [
      /pub async fn wait_for_transport\(&mut self\)/,
      "transport completion hook",
    ],
  ]) {
    if (!pattern.test(coreSession)) {
      violations.push(`SSH transport lifecycle is missing ${description}`);
    }
  }

  const app = source("apps/desktop/src/App.tsx");
  for (const [pattern, description] of [
    [
      /connectionAttemptRef\.current !== attempt/,
      "stale connection-event rejection",
    ],
    [/setConnectionState\("disconnected"\)/, "explicit disconnected state"],
    [/reconnectSession/, "manual reconnect flow"],
    [
      /sftpOperationGenerationRef\.current \+= 1/,
      "SFTP operation invalidation",
    ],
    [/cancelSftpTransfer/, "SFTP transfer cancellation"],
    [/closeTerminalSession/, "terminal close propagation"],
    [/closeSftpSession/, "SFTP close propagation"],
  ]) {
    if (!pattern.test(app)) {
      violations.push(`frontend lifecycle is missing ${description}`);
    }
  }

  const packageJson = parseJson(
    source("package.json"),
    "package.json",
    violations,
  );
  for (const [script, expectedCommand] of Object.entries({
    "stability:controls": "node scripts/check-stability-controls.mjs",
    "stability:test": "node --test scripts/check-stability-controls.test.mjs",
    "stability:report":
      "node scripts/check-stability-controls.mjs --report artifacts/stability/stability-report.json",
  })) {
    if (packageJson?.scripts?.[script] !== expectedCommand) {
      violations.push(`package.json ${script} must run the reviewed command`);
    }
  }
  const workspaceCheck = packageJson?.scripts?.check ?? "";
  for (const command of ["pnpm stability:controls", "pnpm stability:test"]) {
    if (!workspaceCheck.includes(command)) {
      violations.push(`package.json check must include ${command}`);
    }
  }

  const budget = parseJson(
    source(STABILITY_BUDGET_PATH),
    STABILITY_BUDGET_PATH,
    violations,
  );
  violations.push(...validateStabilityBudget(budget));

  const matrix = parseJson(
    source("quality/phase-1-test-matrix.json"),
    "quality/phase-1-test-matrix.json",
    violations,
  );
  const suite = matrix?.testSuites?.find(
    (candidate) => candidate?.id === "QA-STAB-01",
  );
  if (!suite) {
    violations.push("quality matrix is missing QA-STAB-01");
  } else {
    const commands = new Set(suite.commands?.map((command) => command?.run));
    for (const command of ["pnpm stability:controls", "pnpm stability:test"]) {
      if (!commands.has(command)) {
        violations.push(`QA-STAB-01 is missing ${command}`);
      }
    }
    for (const [pattern, description] of [
      [/24 小时/, "a 24-hour soak check"],
      [/休眠\/唤醒/, "a sleep/wake check"],
      [/网络中断/, "a network interruption check"],
      [/stability:report/, "a stability report validation command"],
    ]) {
      if (!suite.manualChecks?.some((check) => pattern.test(check))) {
        violations.push(`QA-STAB-01 must document ${description}`);
      }
    }
    if (
      !suite.artifacts?.some((artifact) =>
        /artifacts\/stability\/stability-report\.json/.test(artifact),
      )
    ) {
      violations.push("QA-STAB-01 must archive a stability report");
    }
    if (
      !suite.artifacts?.some((artifact) => artifact === STABILITY_BUDGET_PATH)
    ) {
      violations.push(
        "QA-STAB-01 must reference the versioned stability budget",
      );
    }
  }

  return violations;
}

export function validateStabilityReport(
  report,
  budget = loadStabilityBudget(),
) {
  const violations = validateStabilityBudget(budget);
  if (!isObject(report)) {
    return [...violations, "stability report must be a JSON object"];
  }
  if (report.schemaVersion !== 1) {
    violations.push("stability report schemaVersion must be 1");
  }
  if (!nonEmptyString(report.generatedAt)) {
    violations.push("stability report generatedAt must be an ISO timestamp");
  } else if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      report.generatedAt,
    ) ||
    Number.isNaN(Date.parse(report.generatedAt))
  ) {
    violations.push(
      "stability report generatedAt must be a valid UTC timestamp",
    );
  }
  for (const [field, description] of [
    ["commit", "the measured commit"],
    ["baselineCommit", "the comparison baseline commit"],
    ["runId", "the stability run identifier"],
    ["measurementMethod", "the measurement method"],
  ]) {
    if (!nonEmptyString(report[field])) {
      violations.push(`stability report ${field} must identify ${description}`);
    }
  }
  if (
    nonEmptyString(report.commit) &&
    nonEmptyString(report.baselineCommit) &&
    report.commit === report.baselineCommit
  ) {
    violations.push(
      "stability report commit and baselineCommit must identify different revisions",
    );
  }
  if (report.processScope !== "all-related-processes") {
    violations.push(
      "stability report processScope must be all-related-processes",
    );
  }
  if (report.result !== "pass") {
    violations.push("stability report result must be pass");
  }

  const referenceEnvironment = budget?.referenceEnvironment;
  const environment = report.environment;
  if (!isObject(environment)) {
    violations.push("stability report environment must be an object");
  } else {
    for (const field of ["platform", "os", "architecture", "storage"]) {
      if (!nonEmptyString(environment[field])) {
        violations.push(`stability report environment.${field} is required`);
      } else if (environment[field] !== referenceEnvironment?.[field]) {
        violations.push(
          `stability report environment.${field} must match the reference environment`,
        );
      }
    }
    for (const field of ["cpuCores", "memoryGb"]) {
      if (!positiveNumber(environment[field])) {
        violations.push(
          `stability report environment.${field} must be positive`,
        );
      } else if (environment[field] !== referenceEnvironment?.[field]) {
        violations.push(
          `stability report environment.${field} must match the reference environment`,
        );
      }
    }
  }

  const durationMinimum = thresholdValue(budget, "soakDurationHours", "min");
  if (!positiveNumber(report.durationHours)) {
    violations.push("stability report durationHours must be positive");
  } else if (
    durationMinimum !== null &&
    report.durationHours < durationMinimum
  ) {
    violations.push(
      `stability report durationHours must be at least ${durationMinimum}`,
    );
  }

  const protocol = budget?.protocol;
  const scenarioCounts = report.scenarioCounts;
  if (!isObject(scenarioCounts)) {
    violations.push("stability report scenarioCounts must be an object");
  } else if (!isObject(protocol)) {
    violations.push(
      "stability report scenarioCounts cannot be evaluated without a valid protocol",
    );
  } else {
    for (const [field, minimum] of Object.entries({
      terminalSessions: protocol.terminalSessionCount,
      sftpSessions: protocol.sftpSessionCount,
      sleepWake: protocol.sleepWakeCycles,
      networkDisconnect: protocol.networkDisconnectCycles,
      reconnect: protocol.reconnectCycles,
      sftpCancellation: protocol.sftpCancellationCycles,
    })) {
      if (!integerAtLeast(scenarioCounts[field], minimum)) {
        violations.push(
          `stability report scenarioCounts.${field} must be at least ${minimum}`,
        );
      }
    }
  }

  const sampleCounts = report.sampleCounts;
  if (!isObject(sampleCounts)) {
    violations.push("stability report sampleCounts must be an object");
  } else if (!isObject(protocol)) {
    violations.push(
      "stability report sampleCounts cannot be evaluated without a valid protocol",
    );
  } else {
    for (const [field, minimum] of Object.entries({
      workingSet: protocol.minimumWorkingSetSamples,
      state: protocol.minimumStateSamples,
      handleSnapshots: protocol.minimumHandleSnapshots,
    })) {
      if (!integerAtLeast(sampleCounts[field], minimum)) {
        violations.push(
          `stability report sampleCounts.${field} must be at least ${minimum}`,
        );
      }
    }
  }

  const measurements = report.measurements;
  if (!isObject(measurements)) {
    return [...violations, "stability report measurements must be an object"];
  }
  for (const field of [
    "steadyStateWorkingSetMb",
    "finalWorkingSetMb",
    "peakWorkingSetMb",
  ]) {
    if (!positiveNumber(measurements[field])) {
      violations.push(
        `stability report measurements.${field} must be positive`,
      );
    }
  }
  if (
    positiveNumber(measurements.steadyStateWorkingSetMb) &&
    positiveNumber(measurements.finalWorkingSetMb) &&
    positiveNumber(measurements.peakWorkingSetMb) &&
    measurements.peakWorkingSetMb <
      Math.max(
        measurements.steadyStateWorkingSetMb,
        measurements.finalWorkingSetMb,
      )
  ) {
    violations.push(
      "stability report measurements.peakWorkingSetMb must cover steady-state and final working sets",
    );
  }

  for (const [field, protocolField] of [
    ["steadyStateWarmupMinutes", "steadyStateWarmupMinutes"],
    ["networkOutageSeconds", "networkOutageSeconds"],
    ["postCleanupObservationMinutes", "postCleanupObservationMinutes"],
  ]) {
    const value = measurements[field];
    const minimum = protocol?.[protocolField];
    if (!positiveNumber(value)) {
      violations.push(
        `stability report measurements.${field} must be positive`,
      );
    } else if (Number.isFinite(minimum) && value < minimum) {
      violations.push(
        `stability report measurements.${field} must be at least ${minimum}`,
      );
    }
  }

  const growthRatio = measurements.workingSetGrowthRatio;
  if (!finiteNumber(growthRatio)) {
    violations.push(
      "stability report measurements.workingSetGrowthRatio must be finite",
    );
  } else {
    const growthLimit = thresholdValue(budget, "workingSetGrowthRatio", "max");
    if (growthLimit !== null && growthRatio > growthLimit) {
      violations.push(
        `stability report measurements.workingSetGrowthRatio must be at most ${growthLimit}`,
      );
    }
    if (positiveNumber(measurements.steadyStateWorkingSetMb)) {
      const calculatedRatio =
        measurements.finalWorkingSetMb / measurements.steadyStateWorkingSetMb -
        1;
      const allowedDifference = Math.max(
        0.005,
        Math.abs(calculatedRatio) * 0.05,
      );
      if (
        finiteNumber(measurements.finalWorkingSetMb) &&
        Math.abs(calculatedRatio - growthRatio) > allowedDifference
      ) {
        violations.push(
          "stability report measurements.workingSetGrowthRatio must match the steady-state and final working sets",
        );
      }
    }
  }

  for (const field of [
    "leakedSessionHandles",
    "leakedTransferHandles",
    "falseConnectedStates",
    "staleHandleOperationsAccepted",
    "unhandledFailures",
  ]) {
    const value = measurements[field];
    if (!nonNegativeInteger(value)) {
      violations.push(
        `stability report measurements.${field} must be a non-negative integer`,
      );
      continue;
    }
    const limit = thresholdValue(budget, field, "max");
    if (limit !== null && value > limit) {
      violations.push(
        `stability report measurements.${field} must be at most ${limit}`,
      );
    }
  }

  for (const field of [
    "sleepWakeStateAccurate",
    "networkDisconnectStateAccurate",
    "reconnectUsedFreshSessionIds",
    "terminalAndSftpIsolationPreserved",
    "cleanupCompleted",
  ]) {
    if (measurements[field] !== true) {
      violations.push(`stability report measurements.${field} must be true`);
    }
  }

  const evidence = report.evidence;
  if (!isObject(evidence)) {
    violations.push("stability report evidence must be an object");
  } else {
    for (const field of [
      "processMemory",
      "lifecycleEvents",
      "faultTimeline",
      "handleSnapshots",
      "failureSummary",
    ]) {
      if (!nonEmptyString(evidence[field])) {
        violations.push(`stability report evidence.${field} is required`);
      } else if (!evidence[field].startsWith("artifacts/stability/")) {
        violations.push(
          `stability report evidence.${field} must be archived under artifacts/stability/`,
        );
      }
    }
  }

  return violations;
}

export function validateStabilityBudget(budget) {
  const violations = [];
  if (!isObject(budget)) {
    return ["stability budget must be a JSON object"];
  }
  if (budget.schemaVersion !== 1) {
    violations.push("stability budget schemaVersion must be 1");
  }
  if (budget.phase !== "P1") {
    violations.push("stability budget phase must be P1");
  }

  const environment = budget.referenceEnvironment;
  if (!isObject(environment)) {
    violations.push("stability budget referenceEnvironment must be an object");
  } else {
    for (const field of ["platform", "os", "architecture", "storage"]) {
      if (!nonEmptyString(environment[field])) {
        violations.push(
          `stability budget referenceEnvironment.${field} is required`,
        );
      }
    }
    for (const field of ["cpuCores", "memoryGb"]) {
      if (!positiveNumber(environment[field])) {
        violations.push(
          `stability budget referenceEnvironment.${field} must be positive`,
        );
      }
    }
  }

  const thresholds = budget.thresholds;
  if (!isObject(thresholds)) {
    violations.push("stability budget thresholds must be an object");
  } else {
    for (const [field, kind] of [
      ["soakDurationHours", "min"],
      ["workingSetGrowthRatio", "max"],
      ["leakedSessionHandles", "max"],
      ["leakedTransferHandles", "max"],
      ["falseConnectedStates", "max"],
      ["staleHandleOperationsAccepted", "max"],
      ["unhandledFailures", "max"],
    ]) {
      const value = thresholds[field]?.[kind];
      const valid =
        kind === "max" ? nonNegativeNumber(value) : positiveNumber(value);
      if (!valid) {
        violations.push(
          `stability budget thresholds.${field}.${kind} must be ${kind === "max" ? "non-negative" : "positive"}`,
        );
      }
      if (!nonEmptyString(thresholds[field]?.unit)) {
        violations.push(
          `stability budget thresholds.${field}.unit is required`,
        );
      }
    }
    if (
      nonNegativeNumber(thresholds.workingSetGrowthRatio?.max) &&
      thresholds.workingSetGrowthRatio.max > 1
    ) {
      violations.push(
        "stability budget thresholds.workingSetGrowthRatio.max must not exceed 1",
      );
    }
    for (const field of [
      "leakedSessionHandles",
      "leakedTransferHandles",
      "falseConnectedStates",
      "staleHandleOperationsAccepted",
      "unhandledFailures",
    ]) {
      if (!Number.isInteger(thresholds[field]?.max)) {
        violations.push(
          `stability budget thresholds.${field}.max must be an integer`,
        );
      }
    }
  }

  const protocol = budget.protocol;
  if (!isObject(protocol)) {
    violations.push("stability budget protocol must be an object");
  } else {
    for (const field of [
      "steadyStateWarmupMinutes",
      "workingSetSampleIntervalSeconds",
      "stateSampleIntervalSeconds",
      "handleSnapshotIntervalMinutes",
      "minimumWorkingSetSamples",
      "minimumStateSamples",
      "minimumHandleSnapshots",
      "terminalSessionCount",
      "sftpSessionCount",
      "sleepWakeCycles",
      "networkDisconnectCycles",
      "reconnectCycles",
      "sftpCancellationCycles",
      "networkOutageSeconds",
      "postCleanupObservationMinutes",
    ]) {
      if (!Number.isInteger(protocol[field]) || protocol[field] <= 0) {
        violations.push(`stability budget protocol.${field} must be positive`);
      }
    }
    const soakSeconds = thresholds?.soakDurationHours?.min * 60 * 60;
    for (const [sampleField, intervalField, intervalMultiplier] of [
      ["minimumWorkingSetSamples", "workingSetSampleIntervalSeconds", 1],
      ["minimumStateSamples", "stateSampleIntervalSeconds", 1],
      ["minimumHandleSnapshots", "handleSnapshotIntervalMinutes", 60],
    ]) {
      if (
        positiveNumber(soakSeconds) &&
        Number.isInteger(protocol[sampleField]) &&
        Number.isInteger(protocol[intervalField]) &&
        protocol[sampleField] * protocol[intervalField] * intervalMultiplier <
          soakSeconds
      ) {
        violations.push(
          `stability budget protocol.${sampleField} must cover the soak duration`,
        );
      }
    }
    for (const field of [
      "freshSessionIdRequired",
      "allRelatedProcessesRequired",
      "baselineCommitRequired",
    ]) {
      if (protocol[field] !== true) {
        violations.push(`stability budget protocol.${field} must be true`);
      }
    }
  }

  if (
    !Array.isArray(budget.requiredEvidence) ||
    budget.requiredEvidence.length === 0 ||
    budget.requiredEvidence.some((evidence) => !nonEmptyString(evidence))
  ) {
    violations.push("stability budget requiredEvidence must contain text");
  }
  return violations;
}

function thresholdValue(budget, field, kind) {
  const value = budget?.thresholds?.[field]?.[kind];
  if (!Number.isFinite(value)) return null;
  return value;
}

function parseJson(value, label, violations) {
  try {
    return JSON.parse(value);
  } catch {
    violations.push(`${label} must contain valid JSON`);
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value) {
  return finiteNumber(value) && value >= 0;
}

function positiveNumber(value) {
  return finiteNumber(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function integerAtLeast(value, minimum) {
  return (
    nonNegativeInteger(value) && (!Number.isFinite(minimum) || value >= minimum)
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const reportArguments = process.argv.slice(2);
  if (
    reportArguments.length !== 0 &&
    (reportArguments.length !== 2 || reportArguments[0] !== "--report")
  ) {
    console.error(
      "Usage: node scripts/check-stability-controls.mjs [--report <path>]",
    );
    process.exit(1);
  }
  const reportPath = reportArguments[1] ?? null;
  const reviewedFiles = loadReviewedFiles();
  const controlViolations = validateStabilityControls(reviewedFiles);
  let reportViolations = [];
  if (reportPath) {
    let report = null;
    let budget = null;
    try {
      budget = JSON.parse(reviewedFiles[STABILITY_BUDGET_PATH]);
    } catch {
      // The control check above reports the malformed budget.
    }
    try {
      report = parseJson(
        readFileSync(path.resolve(reportPath), "utf8"),
        reportPath,
        controlViolations,
      );
    } catch {
      controlViolations.push(
        `stability report file does not exist: ${reportPath}`,
      );
    }
    reportViolations = validateStabilityReport(report, budget);
  }
  const violations = [...controlViolations, ...reportViolations];
  if (violations.length > 0) {
    console.error("Stability control check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log(
    reportPath
      ? `Stability controls and report passed (${reportPath}).`
      : "Stability control check passed (24-hour soak, sleep/wake, network, reconnect, and resource cleanup gates).",
  );
}
