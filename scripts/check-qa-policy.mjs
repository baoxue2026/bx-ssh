import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const policyPath = new URL(
  "../quality/phase-1-test-matrix.json",
  import.meta.url,
);

export function validatePolicy(policy, { workspaceRoot = workspace } = {}) {
  const violations = [];
  const requiredCategories = [
    "functional",
    "compatibility",
    "performance",
    "security",
    "installation",
    "recovery",
  ];
  const allowedBlocking = new Set(["release", "non-blocking"]);
  const allowedCommandTypes = new Set(["automated", "manual"]);
  const allowedDefectLevels = new Set(["P0", "P1", "P2", "P3"]);

  if (!isObject(policy)) {
    return ["QA policy must be a JSON object"];
  }
  if (policy.schemaVersion !== 1) {
    violations.push("QA policy schemaVersion must be 1");
  }
  for (const field of ["phase", "title", "owner", "primaryPlatform"]) {
    if (!nonEmptyString(policy[field])) {
      violations.push(`QA policy ${field} must be a non-empty string`);
    }
  }

  const severities = policy.defectSeverity;
  const releaseGate = policy.releaseGate;
  if (!isObject(releaseGate)) {
    violations.push("QA policy releaseGate must be an object");
  } else {
    for (const field of ["rule"]) {
      if (!nonEmptyString(releaseGate[field])) {
        violations.push(
          `QA policy releaseGate.${field} must be a non-empty string`,
        );
      }
    }
    if (releaseGate.evidenceRequired !== true) {
      violations.push("QA policy releaseGate.evidenceRequired must be true");
    }
    if (
      !Array.isArray(releaseGate.defectLevelsBlockingRelease) ||
      releaseGate.defectLevelsBlockingRelease.length === 0 ||
      releaseGate.defectLevelsBlockingRelease.some(
        (level) => !allowedDefectLevels.has(level),
      )
    ) {
      violations.push(
        "QA policy releaseGate.defectLevelsBlockingRelease must contain only P0-P3 levels",
      );
    }
    if (Array.isArray(severities)) {
      const severityById = new Map(
        severities
          .filter((severity) => isObject(severity))
          .map((severity) => [severity.id, severity]),
      );
      const blockingLevels = Array.isArray(
        releaseGate.defectLevelsBlockingRelease,
      )
        ? releaseGate.defectLevelsBlockingRelease
        : [];
      for (const level of blockingLevels) {
        if (severityById.get(level)?.releaseBlocking !== true) {
          violations.push(
            `QA policy release gate level ${level} must be marked releaseBlocking`,
          );
        }
      }
    }
  }

  if (!Array.isArray(severities)) {
    violations.push("QA policy defectSeverity must be an array");
  } else {
    const ids = severities.map((severity) => severity?.id);
    if (
      ids.length !== allowedDefectLevels.size ||
      new Set(ids).size !== ids.length
    ) {
      violations.push(
        "QA policy defectSeverity must define P0, P1, P2, and P3 exactly once",
      );
    }
    for (const severity of severities) {
      if (!isObject(severity) || !allowedDefectLevels.has(severity.id)) {
        violations.push(
          "QA policy defectSeverity contains an invalid severity id",
        );
        continue;
      }
      for (const field of ["name", "description", "responseTarget"]) {
        if (!nonEmptyString(severity[field])) {
          violations.push(
            `Defect severity ${severity.id} ${field} must be a non-empty string`,
          );
        }
      }
      if (typeof severity.releaseBlocking !== "boolean") {
        violations.push(
          `Defect severity ${severity.id} releaseBlocking must be boolean`,
        );
      }
    }
  }

  const suites = policy.testSuites;
  if (!Array.isArray(suites)) {
    violations.push("QA policy testSuites must be an array");
    return violations;
  }

  const suiteIds = suites.map((suite) => suite?.id);
  const categories = suites.map((suite) => suite?.category);
  if (new Set(suiteIds).size !== suiteIds.length) {
    violations.push("QA policy testSuites ids must be unique");
  }
  for (const category of requiredCategories) {
    if (categories.filter((value) => value === category).length !== 1) {
      violations.push(
        `QA policy must define exactly one ${category} test suite`,
      );
    }
  }
  if (suites.length !== requiredCategories.length) {
    violations.push(
      "QA policy testSuites must contain exactly six phase-1 categories",
    );
  }

  for (const suite of suites) {
    if (!isObject(suite)) {
      violations.push("Each test suite must be an object");
      continue;
    }
    for (const field of ["id", "category", "name", "owner"]) {
      if (!nonEmptyString(suite[field])) {
        violations.push(
          `Test suite ${suite.id ?? "<unknown>"} ${field} must be a non-empty string`,
        );
      }
    }
    if (!allowedBlocking.has(suite.blocking)) {
      violations.push(
        `Test suite ${suite.id ?? "<unknown>"} has an invalid blocking value`,
      );
    }
    if (!Array.isArray(suite.environments) || suite.environments.length === 0) {
      violations.push(
        `Test suite ${suite.id ?? "<unknown>"} must define at least one environment`,
      );
    } else {
      for (const environment of suite.environments) {
        if (!isObject(environment)) {
          violations.push(
            `Test suite ${suite.id ?? "<unknown>"} has an invalid environment`,
          );
          continue;
        }
        for (const field of [
          "id",
          "platform",
          "os",
          "architecture",
          "purpose",
        ]) {
          if (!nonEmptyString(environment[field])) {
            violations.push(
              `Test suite ${suite.id ?? "<unknown>"} environment ${environment.id ?? "<unknown>"} ${field} must be a non-empty string`,
            );
          }
        }
      }
    }
    if (!Array.isArray(suite.commands) || suite.commands.length === 0) {
      violations.push(
        `Test suite ${suite.id ?? "<unknown>"} must define at least one command`,
      );
    } else {
      for (const command of suite.commands) {
        if (!isObject(command) || !nonEmptyString(command.run)) {
          violations.push(
            `Test suite ${suite.id ?? "<unknown>"} has an invalid command`,
          );
          continue;
        }
        if (!allowedCommandTypes.has(command.type)) {
          violations.push(
            `Test suite ${suite.id ?? "<unknown>"} command ${command.run} has an invalid type`,
          );
        }
        if (command.type === "automated") {
          validateCommand(command.run, workspaceRoot, violations);
        }
      }
    }
    if (!Array.isArray(suite.manualChecks) || suite.manualChecks.length === 0) {
      violations.push(
        `Test suite ${suite.id ?? "<unknown>"} must define manualChecks`,
      );
    } else if (suite.manualChecks.some((check) => !nonEmptyString(check))) {
      violations.push(
        `Test suite ${suite.id ?? "<unknown>"} manualChecks must contain text`,
      );
    }
    if (
      !Array.isArray(suite.artifacts) ||
      suite.artifacts.length === 0 ||
      suite.artifacts.some((artifact) => !nonEmptyString(artifact))
    ) {
      violations.push(
        `Test suite ${suite.id ?? "<unknown>"} must define artifact locations`,
      );
    }
    if (suite.blocking === "release" && suite.environments?.length === 0) {
      violations.push(
        `Release-blocking suite ${suite.id ?? "<unknown>"} must have an environment`,
      );
    }
  }

  return violations;
}

function validateCommand(command, workspaceRoot, violations) {
  const pnpmScript = command.match(
    /^pnpm (?:(?:--filter [^ ]+) )?([\w:-]+)$/,
  )?.[1];
  if (pnpmScript) {
    const packagePaths = command.includes("--filter")
      ? ["apps/desktop/package.json"]
      : ["package.json"];
    const found = packagePaths.some((relativePath) => {
      const packagePath = `${workspaceRoot}/${relativePath}`;
      if (!existsSync(packagePath)) return false;
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      return Boolean(packageJson.scripts?.[pnpmScript]);
    });
    if (!found)
      violations.push(
        `Automated command references missing pnpm script: ${command}`,
      );
    return;
  }

  const scriptPath = command.match(/^bash (scripts\/[^ ]+)(?:\s+.*)?$/)?.[1];
  if (scriptPath) {
    if (!existsSync(join(workspaceRoot, ...scriptPath.split("/")))) {
      violations.push(
        `Automated command references missing script: ${command}`,
      );
    }
    return;
  }

  violations.push(`Automated command is not registered: ${command}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadPolicy() {
  return JSON.parse(readFileSync(policyPath, "utf8"));
}

function main() {
  const violations = validatePolicy(loadPolicy());
  if (violations.length > 0) {
    console.error("QA policy check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "QA policy check passed (six phase-1 test categories, owners, environments, gates, and commands).",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
