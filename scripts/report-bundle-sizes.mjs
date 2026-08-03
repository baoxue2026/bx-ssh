import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SIZE_LIMIT_BYTES = 40 * 1024 * 1024;
const PLATFORM_RULES = {
  windows: {
    expected: ["msi", "nsis"],
    limitBytes: SIZE_LIMIT_BYTES,
  },
  macos: {
    expected: ["dmg"],
    limitBytes: SIZE_LIMIT_BYTES,
  },
  linux: {
    expected: ["appimage", "deb", "rpm"],
    limitBytes: null,
  },
};

function parseArguments(argv) {
  const values = {
    bundleDir: "target/release/bundle",
    outputDir: "artifacts/bundle-size",
    platform: platformFromHost(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--bundle-dir" && value) {
      values.bundleDir = value;
      index += 1;
    } else if (argument === "--output-dir" && value) {
      values.outputDir = value;
      index += 1;
    } else if (argument === "--platform" && value) {
      values.platform = value.toLowerCase();
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  if (!(values.platform in PLATFORM_RULES)) {
    throw new Error(
      `Unsupported platform '${values.platform}'. Expected windows, macos, or linux.`,
    );
  }

  return values;
}

function platformFromHost() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

async function findFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? findFiles(entryPath) : [entryPath];
    }),
  );
  return files.flat();
}

function bundleType(filePath, platform) {
  const lowerPath = filePath.toLowerCase();

  if (platform === "windows") {
    if (lowerPath.endsWith(".msi")) return "msi";
    if (lowerPath.endsWith(".exe")) return "nsis";
  }
  if (platform === "macos" && lowerPath.endsWith(".dmg")) return "dmg";
  if (platform === "linux") {
    if (lowerPath.endsWith(".appimage")) return "appimage";
    if (lowerPath.endsWith(".deb")) return "deb";
    if (lowerPath.endsWith(".rpm")) return "rpm";
  }

  return null;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function formatMiB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function markdownReport(report) {
  const limit = report.limitBytes
    ? `${formatMiB(report.limitBytes)} MiB per installer`
    : "record only; no shared Linux limit";
  const rows = report.bundles
    .map(
      (bundle) =>
        `| ${bundle.type} | \`${bundle.path}\` | ${bundle.sizeBytes} | ${bundle.sizeMiB} | ${bundle.sha256} | ${bundle.withinLimit ? "PASS" : "FAIL"} |`,
    )
    .join("\n");

  return `# BX SSH prototype bundle sizes

- Platform: ${report.platform}
- Architecture: ${report.environment.architecture}
- Commit: ${report.environment.commit}
- Size policy: ${limit}
- Result: ${report.passed ? "PASS" : "FAIL"}
- Scope: ${report.scope}

| Type | File | Bytes | MiB | SHA-256 | Budget |
| --- | --- | ---: | ---: | --- | --- |
${rows}
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const bundleDirectory = path.resolve(options.bundleDir);
  const outputDirectory = path.resolve(options.outputDir);
  const rule = PLATFORM_RULES[options.platform];
  const files = await findFiles(bundleDirectory);
  const candidates = files
    .map((filePath) => ({
      filePath,
      type: bundleType(filePath, options.platform),
    }))
    .filter((candidate) => candidate.type !== null)
    .sort((left, right) => left.type.localeCompare(right.type));

  const foundTypes = new Set(candidates.map((candidate) => candidate.type));
  const missingTypes = rule.expected.filter((type) => !foundTypes.has(type));
  if (missingTypes.length > 0) {
    throw new Error(
      `Missing expected bundle type(s): ${missingTypes.join(", ")}`,
    );
  }

  const bundles = await Promise.all(
    candidates.map(async ({ filePath, type }) => {
      const fileStat = await stat(filePath);
      return {
        type,
        path: path
          .relative(bundleDirectory, filePath)
          .split(path.sep)
          .join("/"),
        sizeBytes: fileStat.size,
        sizeMiB: formatMiB(fileStat.size),
        sha256: await sha256(filePath),
        withinLimit:
          rule.limitBytes === null || fileStat.size <= rule.limitBytes,
      };
    }),
  );

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: options.platform,
    scope:
      "G0-06 current prototype; the persistence crate is not yet linked into the desktop executable, so these sizes are not the Phase 1 final package sizes.",
    limitBytes: rule.limitBytes,
    passed: bundles.every((bundle) => bundle.withinLimit),
    environment: {
      architecture: process.env.RUNNER_ARCH ?? process.arch,
      commit: process.env.GITHUB_SHA ?? "local",
      runnerImage: process.env.ImageOS ?? "local",
      runnerImageVersion: process.env.ImageVersion ?? "local",
      node: process.version,
    },
    bundles,
  };

  await mkdir(outputDirectory, { recursive: true });
  const baseName = `bundle-sizes-${options.platform}`;
  await Promise.all([
    writeFile(
      path.join(outputDirectory, `${baseName}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    writeFile(
      path.join(outputDirectory, `${baseName}.md`),
      markdownReport(report),
    ),
  ]);

  for (const bundle of bundles) {
    console.log(
      `${bundle.type}: ${bundle.sizeMiB} MiB (${bundle.withinLimit ? "PASS" : "FAIL"})`,
    );
  }
  console.log(`Reports written to ${outputDirectory}`);

  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
