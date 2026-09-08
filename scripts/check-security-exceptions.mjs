import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function rustExceptions(config) {
  const section = config.split(/^\[advisories\]\s*$/m)[1]?.split(/^\[/m)[0];
  const list = section?.match(/\bignore\s*=\s*\[([\s\S]*?)\]/)?.[1];
  if (list === undefined)
    return {
      entries: [],
      violations: ["Missing Rust advisory exception list"],
    };
  const pattern =
    /\{\s*id\s*=\s*"(RUSTSEC-\d{4}-\d{4})"\s*,\s*reason\s*=\s*"([^"\r\n]+)"\s*,?\s*\}/g;
  const entries = [...list.matchAll(pattern)].map(([, id, reason]) => ({
    id,
    reason,
  }));
  const unparsed = list
    .replace(pattern, "")
    .replace(/#[^\r\n]*/g, "")
    .replace(/[,\s]/g, "");
  return {
    entries,
    violations: unparsed
      ? ["Unrecognized Rust advisory exception; use an id and a review reason"]
      : [],
  };
}

function checkReviewDate(reviewDate, label, today, violations) {
  const parsed = new Date(`${reviewDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate ?? "") ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== reviewDate
  ) {
    violations.push(`${label} has no valid review date`);
  } else if (reviewDate <= today) {
    violations.push(`${label} reached its review date ${reviewDate}`);
  }
}

export function validateSecurityExceptions(
  denyConfig,
  npmPolicy,
  today = new Date().toISOString().slice(0, 10),
) {
  const { entries, violations } = rustExceptions(denyConfig);
  const seen = new Set();
  for (const { id, reason } of entries) {
    if (seen.has(id)) violations.push(`Duplicate advisory exception: ${id}`);
    seen.add(id);
    checkReviewDate(
      reason.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0],
      `Advisory exception ${id}`,
      today,
      violations,
    );
  }
  if (!Array.isArray(npmPolicy?.knownExceptions)) {
    violations.push("Missing npm license exception list");
    return violations;
  }
  for (const entry of npmPolicy.knownExceptions) {
    const id = `${entry.name}@${entry.versions?.join(",")} (${entry.scope})`;
    if (seen.has(id)) violations.push(`Duplicate npm license exception: ${id}`);
    seen.add(id);
    if (
      !entry.name ||
      !Array.isArray(entry.versions) ||
      entry.versions.length === 0 ||
      !entry.license ||
      !entry.reason?.trim() ||
      !["production", "development"].includes(entry.scope)
    ) {
      violations.push(`Incomplete npm license exception: ${id}`);
    }
    checkReviewDate(
      entry.reviewBy,
      `npm license exception ${id}`,
      today,
      violations,
    );
  }
  return violations;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const denyConfig = readFileSync(
    new URL("../deny.toml", import.meta.url),
    "utf8",
  );
  const npmPolicy = JSON.parse(
    readFileSync(
      new URL("../security/npm-license-policy.json", import.meta.url),
      "utf8",
    ),
  );
  const violations = validateSecurityExceptions(denyConfig, npmPolicy);
  if (violations.length > 0) {
    console.error("Security exception expiry gate failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Security exception expiry check passed (${rustExceptions(denyConfig).entries.length} RustSec and ${npmPolicy.knownExceptions.length} npm license exceptions).`,
    );
  }
}
