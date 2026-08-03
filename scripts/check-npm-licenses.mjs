import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const policy = JSON.parse(
  readFileSync(
    new URL("../security/npm-license-policy.json", import.meta.url),
    "utf8",
  ),
);
const production = process.argv.includes("--production");
const command = `pnpm licenses list --json${production ? " --prod" : ""}`;

let report;
try {
  report = JSON.parse(
    execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
} catch (error) {
  console.error(
    "Unable to read the pnpm license inventory:",
    error?.message ?? error,
  );
  process.exit(1);
}

const allowed = new Set(
  production ? policy.productionAllowed : policy.developmentAllowed,
);
const exceptions = new Map(
  policy.knownExceptions
    .filter(
      (entry) => entry.scope === (production ? "production" : "development"),
    )
    .map((entry) => [`${entry.name}@${entry.versions.join(",")}`, entry]),
);
const violations = [];
const seenExceptions = new Set();

for (const [license, packages] of Object.entries(report)) {
  for (const pkg of packages) {
    const versions = pkg.versions ?? [];
    if (allowed.has(license)) continue;
    const matching = exceptions.get(`${pkg.name}@${versions.join(",")}`);
    if (
      matching &&
      matching.license === license &&
      matching.reviewBy >= new Date().toISOString().slice(0, 10)
    ) {
      seenExceptions.add(`${pkg.name}@${versions.join(",")}`);
      continue;
    }
    violations.push(`${pkg.name}@${versions.join(",")} -> ${license}`);
  }
}

for (const key of exceptions.keys()) {
  if (!seenExceptions.has(key))
    violations.push(
      `Registered license exception is absent from the dependency tree: ${key}`,
    );
}

if (violations.length > 0) {
  console.error(
    `${production ? "Production" : "Development"} dependency license gate failed:`,
  );
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `${production ? "Production" : "Development"} dependency license check passed (${Object.values(report).flat().length} grouped entries).`,
);
