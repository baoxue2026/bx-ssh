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
const escapeWorkflowCommand = (value) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const emitError = (title, message) => {
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::error title=${title}::${escapeWorkflowCommand(message)}`);
  }
};

const formatCommandError = (error) => {
  const stderr = error?.stderr?.toString().trim();
  const stdout = error?.stdout?.toString().trim();
  const stdoutExcerpt =
    stdout?.length > 2500
      ? `${stdout.slice(0, 500)}\n... output truncated ...\n${stdout.slice(-2000)}`
      : stdout;
  return [
    error?.message ?? error,
    `exit status: ${error?.status ?? "unknown"}; signal: ${error?.signal ?? "none"}`,
    stderr && `stderr: ${stderr}`,
    stdoutExcerpt && `stdout: ${stdoutExcerpt}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
};

let report;
try {
  report = JSON.parse(
    execSync(command, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
} catch (error) {
  emitError(
    "npm license inventory error",
    `Unable to read the pnpm license inventory: ${formatCommandError(error)}`,
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
      continue;
    }
    violations.push(`${pkg.name}@${versions.join(",")} -> ${license}`);
  }
}

if (violations.length > 0) {
  const scope = production ? "Production" : "Development";
  console.error(`${scope} dependency license gate failed:`);
  for (const violation of violations) {
    emitError(`${scope} dependency license violation`, `- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `${production ? "Production" : "Development"} dependency license check passed (${Object.values(report).flat().length} grouped entries).`,
);
