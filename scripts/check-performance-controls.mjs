import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const PERFORMANCE_BUDGET_PATH = "quality/phase-1-performance-budget.json";

const reviewedPaths = [
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/components/TerminalPane.tsx",
  "apps/desktop/src-tauri/src/terminal.rs",
  "crates/ssh-core/src/sftp.rs",
  "package.json",
  PERFORMANCE_BUDGET_PATH,
  "quality/phase-1-test-matrix.json",
];

export function loadPerformanceBudget(root = workspace) {
  return JSON.parse(
    readFileSync(path.join(root, PERFORMANCE_BUDGET_PATH), "utf8"),
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

export function validatePerformanceControls(files) {
  const violations = [];
  const source = (relativePath) => files[relativePath] ?? "";
  const requireText = (relativePath, pattern, description) => {
    if (!pattern.test(source(relativePath))) {
      violations.push(`${relativePath} is missing ${description}`);
    }
  };

  requireText(
    "apps/desktop/src/components/TerminalPane.tsx",
    /scrollback:\s*100[_]?000/,
    "the 100,000-line scrollback budget",
  );
  requireText(
    "apps/desktop/src/App.tsx",
    /setWebviewMemoryUsage\(true\)/,
    "low-memory mode while terminal output is active",
  );
  requireText(
    "apps/desktop/src/App.tsx",
    /setWebviewMemoryUsage\(false\)/,
    "memory-budget recovery after terminal output",
  );
  requireText(
    "apps/desktop/src/App.tsx",
    /acknowledgeTerminalOutput\(/,
    "acknowledgement-based terminal backpressure",
  );

  const terminal = source("apps/desktop/src-tauri/src/terminal.rs");
  for (const [pattern, description] of [
    [
      /OUTPUT_BATCH_MAX_BYTES\s*:\s*usize\s*=\s*64\s*\*\s*1024/,
      "a bounded terminal output batch",
    ],
    [
      /OUTPUT_MAX_IN_FLIGHT_BATCHES\s*:\s*usize\s*=\s*8/,
      "a bounded output acknowledgement window",
    ],
    [
      /OUTPUT_ACK_TIMEOUT\s*:\s*Duration\s*=\s*Duration::from_secs\(60\)/,
      "an output acknowledgement timeout",
    ],
    [/fn\s+can_read\(&self\)/, "read-side backpressure"],
  ]) {
    if (!pattern.test(terminal)) {
      violations.push(`terminal output flow is missing ${description}`);
    }
  }

  const sftp = source("crates/ssh-core/src/sftp.rs");
  for (const [pattern, description] of [
    [
      /TRANSFER_BUFFER_BYTES\s*:\s*usize\s*=\s*256\s*\*\s*1024/,
      "a bounded SFTP transfer buffer",
    ],
    [/Sha256::new\(\)/, "streaming SHA-256 calculation"],
    [/verify_transfer_integrity\(/, "post-transfer integrity verification"],
    [/bytes_per_second/, "transfer throughput reporting"],
  ]) {
    if (!pattern.test(sftp)) {
      violations.push(`SFTP performance path is missing ${description}`);
    }
  }

  const packageJson = parseJson(
    source("package.json"),
    "package.json",
    violations,
  );
  if (
    packageJson?.scripts?.["bundle:report"] !==
    "node scripts/report-bundle-sizes.mjs"
  ) {
    violations.push(
      "bundle:report must invoke scripts/report-bundle-sizes.mjs so the performance gate is executable",
    );
  }
  for (const [script, expectedCommand] of Object.entries({
    "performance:controls": "node scripts/check-performance-controls.mjs",
    "performance:test":
      "node --test scripts/check-performance-controls.test.mjs",
    "performance:report":
      "node scripts/check-performance-controls.mjs --report artifacts/performance/performance-report.json",
  })) {
    if (packageJson?.scripts?.[script] !== expectedCommand) {
      violations.push(`package.json ${script} must run the reviewed command`);
    }
  }
  const workspaceCheck = packageJson?.scripts?.check ?? "";
  for (const command of [
    "pnpm performance:controls",
    "pnpm performance:test",
  ]) {
    if (!workspaceCheck.includes(command)) {
      violations.push(`package.json check must include ${command}`);
    }
  }

  const performanceBudget = parseJson(
    source(PERFORMANCE_BUDGET_PATH),
    PERFORMANCE_BUDGET_PATH,
    violations,
  );
  violations.push(...validatePerformanceBudget(performanceBudget));

  const matrix = parseJson(
    source("quality/phase-1-test-matrix.json"),
    "quality/phase-1-test-matrix.json",
    violations,
  );
  const suite = matrix?.testSuites?.find(({ id }) => id === "QA-PERF-01");
  if (!suite) {
    violations.push("quality matrix is missing QA-PERF-01");
  } else {
    const commands = new Set(suite.commands?.map(({ run }) => run));
    for (const command of [
      "pnpm performance:controls",
      "pnpm performance:test",
    ]) {
      if (!commands.has(command)) {
        violations.push(`QA-PERF-01 is missing ${command}`);
      }
    }
    if (!suite.manualChecks?.some((check) => /10 个 SSH 会话/.test(check))) {
      violations.push("QA-PERF-01 must require a 10-session resource run");
    }
    if (
      !suite.artifacts?.some((artifact) =>
        /artifacts\/performance/.test(artifact),
      )
    ) {
      violations.push("QA-PERF-01 must archive a performance report");
    }
    if (
      !suite.artifacts?.some((artifact) => artifact === PERFORMANCE_BUDGET_PATH)
    ) {
      violations.push(
        "QA-PERF-01 must reference the versioned performance budget",
      );
    }
    if (
      !suite.manualChecks?.some((check) => /performance:report/.test(check))
    ) {
      violations.push(
        "QA-PERF-01 must document the performance report validation command",
      );
    }
  }

  return violations;
}

export function validatePerformanceReport(
  report,
  budget = loadPerformanceBudget(),
) {
  const violations = validatePerformanceBudget(budget);
  if (!isObject(report)) {
    return [...violations, "performance report must be a JSON object"];
  }
  if (report.schemaVersion !== 1) {
    violations.push("performance report schemaVersion must be 1");
  }
  if (!nonEmptyString(report.generatedAt)) {
    violations.push("performance report generatedAt must be an ISO timestamp");
  } else if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      report.generatedAt,
    ) ||
    Number.isNaN(Date.parse(report.generatedAt))
  ) {
    violations.push(
      "performance report generatedAt must be a valid UTC timestamp",
    );
  }
  for (const [field, description] of [
    ["commit", "the measured commit"],
    ["baselineCommit", "the comparison baseline commit"],
    ["measurementMethod", "the measurement method"],
  ]) {
    if (!nonEmptyString(report[field])) {
      violations.push(
        `performance report ${field} must identify ${description}`,
      );
    }
  }
  if (report.processScope !== "all-related-processes") {
    violations.push(
      "performance report processScope must be all-related-processes",
    );
  }
  if (report.result !== "pass") {
    violations.push("performance report result must be pass");
  }

  const referenceEnvironment = budget?.referenceEnvironment;
  const environment = report.environment;
  if (!isObject(environment)) {
    violations.push("performance report environment must be an object");
  } else {
    for (const field of ["platform", "os", "architecture"]) {
      if (!nonEmptyString(environment[field])) {
        violations.push(`performance report environment.${field} is required`);
      } else if (environment[field] !== referenceEnvironment?.[field]) {
        violations.push(
          `performance report environment.${field} must match the reference environment`,
        );
      }
    }
    for (const field of ["cpuCores", "memoryGb"]) {
      if (!positiveNumber(environment[field])) {
        violations.push(
          `performance report environment.${field} must be positive`,
        );
      } else if (environment[field] !== referenceEnvironment?.[field]) {
        violations.push(
          `performance report environment.${field} must match the reference environment`,
        );
      }
    }
    if (environment.storage !== referenceEnvironment?.storage) {
      violations.push(
        "performance report environment.storage must match the reference environment",
      );
    }
  }

  const protocol = budget?.protocol;
  const sampleCounts = report.sampleCounts;
  if (!isObject(sampleCounts)) {
    violations.push("performance report sampleCounts must be an object");
  } else if (!isObject(protocol)) {
    violations.push(
      "performance report sampleCounts cannot be evaluated without a valid protocol",
    );
  } else {
    const workingSetSamples = Math.ceil(
      protocol.workingSetObservationSeconds /
        protocol.workingSetSampleIntervalSeconds,
    );
    const minimums = {
      startup: protocol.startupSamples,
      trayRestore: protocol.startupSamples,
      idleWorkingSet: workingSetSamples,
      tenSessionWorkingSet: workingSetSamples,
      tabSwitch: protocol.tabSwitchSamples,
      terminalOutput: protocol.terminalOutputRuns,
      sftp: protocol.sftpRuns,
    };
    for (const [field, minimum] of Object.entries(minimums)) {
      if (
        !Number.isInteger(sampleCounts[field]) ||
        sampleCounts[field] < minimum
      ) {
        violations.push(
          `performance report sampleCounts.${field} must be at least ${minimum}`,
        );
      }
    }
  }

  const measurements = report.measurements;
  if (!isObject(measurements)) {
    return [...violations, "performance report measurements must be an object"];
  }
  const boundedMetrics = [
    ["coldStartP95Ms", "max"],
    ["idleWorkingSetMb", "max"],
    ["tenSessionWorkingSetMb", "max"],
    ["tabSwitchP95Ms", "max"],
  ];
  for (const [field, kind] of boundedMetrics) {
    const value = measurements[field];
    const limit = thresholdValue(budget, field, kind);
    if (!nonNegativeNumber(value)) {
      violations.push(
        `performance report measurements.${field} must be non-negative`,
      );
    } else if (limit !== null && value > limit) {
      violations.push(
        `performance report measurements.${field} must be at most ${limit}`,
      );
    }
  }

  if (!nonNegativeNumber(measurements.trayRestoreP95Ms)) {
    violations.push(
      "performance report measurements.trayRestoreP95Ms must be non-negative",
    );
  }

  const minimumMetrics = [
    ["terminalOutputBytesPerSecond", "min"],
    ["terminalOutputDurationSeconds", "min"],
    ["sftpBytes", "min"],
    ["sftpSpeedRatio", "min"],
  ];
  for (const [field, kind] of minimumMetrics) {
    const value = measurements[field];
    const limit = thresholdValue(budget, field, kind);
    if (!nonNegativeNumber(value)) {
      violations.push(
        `performance report measurements.${field} must be non-negative`,
      );
    } else if (limit !== null && value < limit) {
      violations.push(
        `performance report measurements.${field} must be at least ${limit}`,
      );
    }
  }

  for (const field of ["sftpBytesPerSecond", "sftpBaselineBytesPerSecond"]) {
    if (!positiveNumber(measurements[field])) {
      violations.push(
        `performance report measurements.${field} must be positive`,
      );
    }
  }

  for (const field of [
    "terminalUiResponsive",
    "terminalMemoryRecovered",
    "sftpSha256Match",
  ]) {
    if (measurements[field] !== true) {
      violations.push(`performance report measurements.${field} must be true`);
    }
  }

  if (
    positiveNumber(measurements.sftpBytesPerSecond) &&
    positiveNumber(measurements.sftpBaselineBytesPerSecond) &&
    positiveNumber(measurements.sftpSpeedRatio)
  ) {
    const calculatedRatio =
      measurements.sftpBytesPerSecond / measurements.sftpBaselineBytesPerSecond;
    const allowedDifference = Math.max(0.02, calculatedRatio * 0.05);
    if (
      Math.abs(calculatedRatio - measurements.sftpSpeedRatio) >
      allowedDifference
    ) {
      violations.push(
        "performance report measurements.sftpSpeedRatio must match the measured and baseline SFTP rates",
      );
    }
  }

  const sessionMinimum = thresholdValue(budget, "sessionCount", "min");
  if (
    !Number.isInteger(report.sessionCount) ||
    (sessionMinimum !== null && report.sessionCount < sessionMinimum)
  ) {
    violations.push(
      `performance report sessionCount must be at least ${sessionMinimum ?? "the configured minimum"}`,
    );
  }
  return violations;
}

export function validatePerformanceBudget(budget) {
  const violations = [];
  if (!isObject(budget)) {
    return ["performance budget must be a JSON object"];
  }
  if (budget.schemaVersion !== 1) {
    violations.push("performance budget schemaVersion must be 1");
  }
  if (budget.phase !== "P1") {
    violations.push("performance budget phase must be P1");
  }

  const environment = budget.referenceEnvironment;
  if (!isObject(environment)) {
    violations.push(
      "performance budget referenceEnvironment must be an object",
    );
  } else {
    for (const field of ["platform", "os", "architecture", "storage"]) {
      if (!nonEmptyString(environment[field])) {
        violations.push(
          `performance budget referenceEnvironment.${field} is required`,
        );
      }
    }
    for (const field of ["cpuCores", "memoryGb"]) {
      if (!positiveNumber(environment[field])) {
        violations.push(
          `performance budget referenceEnvironment.${field} must be positive`,
        );
      }
    }
  }

  const thresholds = budget.thresholds;
  if (!isObject(thresholds)) {
    violations.push("performance budget thresholds must be an object");
  } else {
    for (const [field, kind] of [
      ["coldStartP95Ms", "max"],
      ["idleWorkingSetMb", "max"],
      ["tenSessionWorkingSetMb", "max"],
      ["tabSwitchP95Ms", "max"],
      ["terminalOutputBytesPerSecond", "min"],
      ["terminalOutputDurationSeconds", "min"],
      ["sftpBytes", "min"],
      ["sftpSpeedRatio", "min"],
      ["sessionCount", "min"],
    ]) {
      const value = thresholds[field]?.[kind];
      if (!positiveNumber(value)) {
        violations.push(
          `performance budget thresholds.${field}.${kind} must be positive`,
        );
      }
      if (!nonEmptyString(thresholds[field]?.unit)) {
        violations.push(
          `performance budget thresholds.${field}.unit is required`,
        );
      }
    }
  }

  if (
    !Array.isArray(budget.recordOnlyMetrics) ||
    budget.recordOnlyMetrics.length !== 1 ||
    budget.recordOnlyMetrics[0] !== "trayRestoreP95Ms"
  ) {
    violations.push(
      "performance budget recordOnlyMetrics must contain trayRestoreP95Ms",
    );
  }

  const protocol = budget.protocol;
  if (!isObject(protocol)) {
    violations.push("performance budget protocol must be an object");
  } else {
    for (const field of [
      "startupSamples",
      "workingSetObservationSeconds",
      "workingSetSampleIntervalSeconds",
      "tabSwitchSamples",
      "terminalOutputRuns",
      "sftpRuns",
    ]) {
      if (!Number.isInteger(protocol[field]) || protocol[field] <= 0) {
        violations.push(
          `performance budget protocol.${field} must be positive`,
        );
      }
    }
    if (
      Number.isInteger(protocol.workingSetObservationSeconds) &&
      Number.isInteger(protocol.workingSetSampleIntervalSeconds) &&
      protocol.workingSetObservationSeconds <
        protocol.workingSetSampleIntervalSeconds
    ) {
      violations.push(
        "performance budget working-set observation must be at least one sample interval",
      );
    }
    for (const field of ["terminalOutputPattern", "sftpComparison"]) {
      if (!nonEmptyString(protocol[field])) {
        violations.push(`performance budget protocol.${field} is required`);
      }
    }
    if (protocol.baselineCommitRequired !== true) {
      violations.push(
        "performance budget protocol.baselineCommitRequired must be true",
      );
    }
  }

  if (
    !Array.isArray(budget.requiredEvidence) ||
    budget.requiredEvidence.length === 0 ||
    budget.requiredEvidence.some((evidence) => !nonEmptyString(evidence))
  ) {
    violations.push("performance budget requiredEvidence must contain text");
  }
  return violations;
}

function thresholdValue(budget, field, kind) {
  const value = budget?.thresholds?.[field]?.[kind];
  if (!positiveNumber(value)) {
    return null;
  }
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

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
      "Usage: node scripts/check-performance-controls.mjs [--report <path>]",
    );
    process.exit(1);
  }
  const reportPath = reportArguments[1] ?? null;

  const reviewedFiles = loadReviewedFiles();
  const controlViolations = validatePerformanceControls(reviewedFiles);
  let reportViolations = [];
  if (reportPath) {
    let report = null;
    let budget = null;
    try {
      budget = JSON.parse(reviewedFiles[PERFORMANCE_BUDGET_PATH]);
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
        `performance report file does not exist: ${reportPath}`,
      );
    }
    reportViolations = validatePerformanceReport(report, budget);
  }
  const violations = [...controlViolations, ...reportViolations];
  if (violations.length > 0) {
    console.error("Performance control check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log(
    reportPath
      ? `Performance controls and report passed (${reportPath}).`
      : "Performance control check passed (startup, memory, sessions, terminal output, and SFTP gates).",
  );
}
