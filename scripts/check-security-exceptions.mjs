import { readFileSync } from "node:fs";

const denyConfig = readFileSync(
  new URL("../deny.toml", import.meta.url),
  "utf8",
);
const entries = [
  ...denyConfig.matchAll(
    /\{ id = "(RUSTSEC-\d{4}-\d{4})", reason = "([^"]+)" \}/g,
  ),
];
const today = new Date().toISOString().slice(0, 10);
const seen = new Set();
const violations = [];

for (const [, id, reason] of entries) {
  if (seen.has(id)) violations.push(`Duplicate advisory exception: ${id}`);
  seen.add(id);

  const reviewDate = reason.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  if (!reviewDate) {
    violations.push(`Advisory exception has no review date: ${id}`);
  } else if (reviewDate <= today) {
    violations.push(
      `Advisory exception reached its review date ${reviewDate}: ${id}`,
    );
  }
}

if (violations.length > 0) {
  console.error("Security exception expiry gate failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Security exception expiry check passed (${entries.length} RustSec exceptions).`,
);
