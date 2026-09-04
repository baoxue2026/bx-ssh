import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BUNDLE_EXTENSIONS = new Set([
  ".appimage",
  ".deb",
  ".dmg",
  ".exe",
  ".msi",
  ".rpm",
  ".tar.gz",
  ".zip",
]);
const SYMBOL_EXTENSIONS = new Set([".pdb", ".debug", ".sym"]);
const SECRET_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !value) {
      throw new Error(
        `Unknown or incomplete argument: ${argument ?? "<missing>"}`,
      );
    }
    values[argument.slice(2)] = value;
  }
  for (const required of ["platform", "version", "bundle-dir", "output-dir"]) {
    if (!values[required])
      throw new Error(`Missing required argument --${required}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(values.version)) {
    throw new Error(
      "Release evidence version must contain only letters, numbers, dots, underscores, or hyphens",
    );
  }
  if (!/^[a-z0-9-]+$/.test(values.platform)) {
    throw new Error(
      "Release evidence platform must contain lowercase letters, numbers, or hyphens",
    );
  }
  return values;
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(root, entry.name);
      return entry.isDirectory() ? listFiles(absolute) : [absolute];
    }),
  );
  return nested.flat();
}

function extension(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  return path.extname(lower);
}

function isSecret(filePath) {
  return (
    SECRET_EXTENSIONS.has(extension(filePath)) ||
    /(?:^|[._-])(signing|private|secret)(?:[._-]|$)/i.test(
      path.basename(filePath),
    )
  );
}

function isBundle(filePath) {
  return BUNDLE_EXTENSIONS.has(extension(filePath));
}

function isSymbol(filePath) {
  const lower = filePath.toLowerCase();
  return (
    SYMBOL_EXTENSIONS.has(extension(filePath)) ||
    lower.endsWith(".dSYM".toLowerCase())
  );
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function relativeUnix(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function signatureFor(filePath) {
  return `${filePath}.sig`;
}

async function copyIfPresent(source, destination) {
  try {
    await stat(source);
  } catch {
    return false;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  return true;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const bundleRoot = path.resolve(options["bundle-dir"]);
  const outputRoot = path.resolve(options["output-dir"]);
  const symbolRoot = options["symbol-root"]
    ? path.resolve(options["symbol-root"])
    : path.dirname(bundleRoot);
  const reportsRoot = options["reports-dir"]
    ? path.resolve(options["reports-dir"])
    : null;
  const installerSignatureReport = options["installer-signature-report"]
    ? path.resolve(options["installer-signature-report"])
    : null;
  const versionRoot = path.join(outputRoot, options.version, options.platform);
  const bundleOutput = path.join(versionRoot, "bundles");
  const symbolsOutput = path.join(versionRoot, "symbols");
  await mkdir(bundleOutput, { recursive: true });
  await mkdir(symbolsOutput, { recursive: true });

  const files = await listFiles(bundleRoot);
  const candidates = files.filter(
    (filePath) =>
      !isSecret(filePath) &&
      (isBundle(filePath) || filePath.toLowerCase().endsWith(".sig")),
  );
  const symbolFiles = await listFiles(symbolRoot);
  const symbols = symbolFiles.filter(
    (filePath) => !isSecret(filePath) && isSymbol(filePath),
  );
  const artifacts = [];
  const copiedBySource = new Map();
  let installerSigned = false;
  let installerSignatureEvidence = null;

  if (installerSignatureReport) {
    let report;
    try {
      report = JSON.parse(await readFile(installerSignatureReport, "utf8"));
    } catch {
      throw new Error(
        `Windows Authenticode report does not exist or is invalid: ${installerSignatureReport}`,
      );
    }
    if (report?.passed !== true || !Array.isArray(report.artifacts)) {
      throw new Error(
        "Windows Authenticode report must have passed=true and an artifacts array",
      );
    }
    const reportDestination = path.join(
      versionRoot,
      "reports",
      "windows-signature-report.json",
    );
    await mkdir(path.dirname(reportDestination), { recursive: true });
    await cp(installerSignatureReport, reportDestination, { force: true });
    installerSigned =
      report.artifacts.length > 0 &&
      report.artifacts.every((artifact) => artifact?.status === "valid");
    installerSignatureEvidence = `artifacts/release/${options.version}/${options.platform}/reports/windows-signature-report.json`;
    if (!installerSigned) {
      throw new Error(
        "Windows Authenticode report contains an invalid signature",
      );
    }
  }

  for (const source of candidates.sort()) {
    const destination = path.join(
      bundleOutput,
      relativeUnix(bundleRoot, source),
    );
    if (!(await copyIfPresent(source, destination))) continue;
    copiedBySource.set(source, destination);
  }

  const bundleFiles = files
    .filter((filePath) => !isSecret(filePath) && isBundle(filePath))
    .sort();
  for (const source of bundleFiles) {
    const destination = copiedBySource.get(source);
    if (!destination) continue;
    const signatureSource = signatureFor(source);
    const signatureDestination = copiedBySource.get(signatureSource);
    const artifactPath = `artifacts/release/${options.version}/${options.platform}/bundles/${relativeUnix(bundleRoot, source)}`;
    const signaturePath = signatureDestination
      ? `artifacts/release/${options.version}/${options.platform}/bundles/${relativeUnix(bundleRoot, signatureSource)}`
      : null;
    artifacts.push({
      platform: options.platform,
      type: bundleType(source),
      path: artifactPath,
      sizeBytes: (await stat(source)).size,
      sha256: await sha256(source),
      signed: Boolean(signatureDestination),
      signaturePath,
      installerSigned,
      installerSignatureEvidence,
      symbols: [],
    });
  }

  const symbolPaths = [];
  for (const source of symbols.sort()) {
    const relative = relativeUnix(symbolRoot, source);
    const destination = path.join(symbolsOutput, relative);
    if (!(await copyIfPresent(source, destination))) continue;
    symbolPaths.push(
      `artifacts/release/${options.version}/${options.platform}/symbols/${relative}`,
    );
  }
  for (const artifact of artifacts) artifact.symbols = [...symbolPaths];

  const reportPaths = [];
  if (reportsRoot) {
    for (const candidate of [
      path.join(reportsRoot, "bundle-size"),
      path.join(reportsRoot, "updater", "reports"),
    ]) {
      try {
        const reportFiles = (await listFiles(candidate)).filter(
          (filePath) => !isSecret(filePath),
        );
        for (const reportFile of reportFiles) {
          const relative = relativeUnix(reportsRoot, reportFile);
          const destination = path.join(versionRoot, "reports", relative);
          if (await copyIfPresent(reportFile, destination)) {
            reportPaths.push(
              `artifacts/release/${options.version}/${options.platform}/reports/${relative}`,
            );
          }
        }
      } catch {
        // A platform may not produce every optional report; the release gate
        // validates the aggregate manifest after all platform jobs complete.
      }
    }
  }

  const checksumLines = [];
  for (const artifact of artifacts)
    checksumLines.push(`${artifact.sha256}  ${artifact.path}`);
  const checksumPath = path.join(versionRoot, "checksums-sha256.txt");
  await writeFile(
    checksumPath,
    `${checksumLines.sort().join("\n")}${checksumLines.length ? "\n" : ""}`,
  );

  const fragment = {
    schemaVersion: 1,
    version: options.version,
    platform: options.platform,
    generatedAt: new Date().toISOString(),
    artifacts,
    symbols: symbolPaths,
    reports: reportPaths,
    checksums: `artifacts/release/${options.version}/${options.platform}/checksums-sha256.txt`,
  };
  await writeFile(
    path.join(versionRoot, "release-evidence.json"),
    `${JSON.stringify(fragment, null, 2)}\n`,
  );
  console.log(
    `Prepared ${artifacts.length} release artifacts for ${options.platform} in ${versionRoot}`,
  );
}

function bundleType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".msi")) return "msi";
  if (lower.endsWith(".exe")) return "nsis";
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".deb")) return "deb";
  if (lower.endsWith(".rpm")) return "rpm";
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  return "unknown";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(
      `::error title=Release evidence preparation failed::${message}`,
    );
  }
  process.exitCode = 1;
});
