import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const ACCEPTANCE_STATUS_PATH = "quality/phase-1-acceptance-status.json";

const EXPECTED_ITEMS = new Set([
  "QA-COMP-01",
  "QA-INSTALL-01",
  "QA-PERF-STAB-01",
  "QA-MANUAL-WINDOWS-01",
  "QA-TRACEABILITY-01",
  "RELEASE-PROTECTION-01",
]);
const STATES = new Set([
  "implemented",
  "partially_verified",
  "ready_for_ci",
  "pending_external",
  "implemented_pending_external",
  "blocked",
]);

export function loadAcceptanceStatus(root = workspace) {
  return JSON.parse(
    readFileSync(path.join(root, ACCEPTANCE_STATUS_PATH), "utf8"),
  );
}

export function validateAcceptanceStatus(status) {
  const violations = [];
  if (!isObject(status)) return ["acceptance status must be a JSON object"];
  if (status.schemaVersion !== 1) {
    violations.push("acceptance status schemaVersion must be 1");
  }
  if (status.phase !== "P1") {
    violations.push("acceptance status phase must be P1");
  }
  if (!validUtcTimestamp(status.updatedAt)) {
    violations.push(
      "acceptance status updatedAt must be a valid UTC timestamp",
    );
  }
  if (!["ready", "blocked"].includes(status.releaseReadiness)) {
    violations.push(
      "acceptance status releaseReadiness must be ready or blocked",
    );
  }
  if (!nonEmptyString(status.releaseReadinessReason)) {
    violations.push("acceptance status releaseReadinessReason is required");
  }

  if (!Array.isArray(status.items)) {
    violations.push("acceptance status items must be an array");
    return violations;
  }
  const ids = status.items.map((item) => item?.id);
  if (ids.length !== EXPECTED_ITEMS.size || new Set(ids).size !== ids.length) {
    violations.push("acceptance status must contain six unique tracked items");
  }
  for (const id of EXPECTED_ITEMS) {
    if (!ids.includes(id))
      violations.push(`acceptance status is missing ${id}`);
  }
  for (const item of status.items) {
    if (!isObject(item) || !nonEmptyString(item.id)) {
      violations.push("acceptance status item must have an id");
      continue;
    }
    if (!EXPECTED_ITEMS.has(item.id)) {
      violations.push(`acceptance status contains unknown item ${item.id}`);
    }
    if (!nonEmptyString(item.title)) {
      violations.push(`acceptance status ${item.id} title is required`);
    }
    if (!STATES.has(item.state)) {
      violations.push(`acceptance status ${item.id} has an invalid state`);
    }
    if (item.blocking !== true) {
      violations.push(
        `acceptance status ${item.id} must declare blocking=true`,
      );
    }
    if (!nonEmptyStringArray(item.evidence)) {
      violations.push(
        `acceptance status ${item.id} evidence must not be empty`,
      );
    }
    if (!stringArray(item.pendingEvidence)) {
      violations.push(
        `acceptance status ${item.id} pendingEvidence must be an array of strings`,
      );
    }
    if (item.state === "implemented" && item.pendingEvidence?.length > 0) {
      violations.push(
        `acceptance status ${item.id} cannot be implemented while pending evidence remains`,
      );
    }
  }
  if (
    status.releaseReadiness === "ready" &&
    status.items.some((item) => item?.state !== "implemented")
  ) {
    violations.push(
      "acceptance status cannot be ready until every tracked item is implemented",
    );
  }
  return violations;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
  );
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function validUtcTimestamp(value) {
  return (
    nonEmptyString(value) &&
    value.endsWith("Z") &&
    !Number.isNaN(Date.parse(value))
  );
}

function main() {
  const violations = validateAcceptanceStatus(loadAcceptanceStatus());
  if (violations.length > 0) {
    console.error(violations.map((violation) => `- ${violation}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  const status = loadAcceptanceStatus();
  const counts = Object.groupBy(status.items, (item) => item.state);
  console.log(
    `Phase-1 acceptance status passed (${status.items.length} items; ${Object.keys(counts).length} states; readiness=${status.releaseReadiness}).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
