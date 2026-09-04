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

const REQUIRED_SUITE_IDS = [
  "QA-FUNC-01",
  "QA-COMP-01",
  "QA-PERF-01",
  "QA-STAB-01",
  "QA-SEC-01",
  "QA-INSTALL-01",
  "QA-RECOVERY-01",
  "QA-REL-01",
];

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
  for (const required of ["version", "commit", "input-dir", "output"]) {
    if (!values[required])
      throw new Error(`Missing required argument --${required}`);
  }
  if (!/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(values.version)) {
    throw new Error(`Unsupported release version: ${values.version}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(values.commit)) {
    throw new Error("Release commit must be a 40-character Git SHA");
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function archivePath(value) {
  if (
    typeof value !== "string" ||
    value.includes("..") ||
    value.includes("\\")
  ) {
    return null;
  }
  return value.startsWith("artifacts/") ? value : null;
}

function channelForVersion(version) {
  if (/-rc\.\d+$/.test(version)) return "rc";
  if (/(?:-alpha|-beta)\.\d+$/.test(version)) return "preview";
  return "stable";
}

function platformId(platform) {
  const normalized = String(platform).toLowerCase();
  if (normalized === "windows" || normalized === "windows-x64")
    return "windows-x64";
  if (normalized === "macos" || normalized === "macos-x64") return "macos-x64";
  if (normalized === "linux" || normalized === "linux-x64") return "linux-x64";
  return normalized;
}

async function findFirst(files, predicate) {
  for (const filePath of files) {
    if (predicate(filePath)) return filePath;
  }
  return null;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function componentCounts(sbom) {
  const counts = {};
  for (const component of sbom.components ?? []) {
    const purl = component?.purl;
    if (typeof purl !== "string") continue;
    for (const prefix of ["pkg:cargo/", "pkg:npm/"]) {
      if (purl.startsWith(prefix)) counts[prefix] = (counts[prefix] ?? 0) + 1;
    }
  }
  return counts;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inputRoot = path.resolve(options["input-dir"]);
  const outputPath = path.resolve(options.output);
  if (!(await existsDirectory(inputRoot))) {
    throw new Error(
      `Release artifact input directory does not exist: ${inputRoot}`,
    );
  }
  const files = (await listFiles(inputRoot)).sort();
  const forbidden = files.filter((filePath) =>
    /(?:^|[._-])(signing|private|secret)(?:[._-]|$)|\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(
      path.basename(filePath),
    ),
  );
  if (forbidden.length > 0) {
    throw new Error("Release evidence input contains private signing material");
  }
  const fragmentPaths = files.filter(
    (filePath) => path.basename(filePath) === "release-evidence.json",
  );
  if (fragmentPaths.length === 0) {
    throw new Error(
      "No release-evidence.json fragments were found in the input directory",
    );
  }
  const fragments = await Promise.all(fragmentPaths.map(readJson));
  const metadataPath = await findFirst(files, (filePath) =>
    /(?:^|[-_])release-(?:metadata|qa-report)\.json$/i.test(
      path.basename(filePath),
    ),
  );
  if (!metadataPath) {
    throw new Error(
      "Release metadata is required; provide release-metadata.json or release-qa-report.json with suite, defect, signature, and provenance evidence",
    );
  }
  const metadata = await readJson(metadataPath);
  if (
    /-----BEGIN [^-]*PRIVATE KEY-----|"(?:password|privateKey|token|secret)"\s*:/i.test(
      JSON.stringify(metadata),
    )
  ) {
    throw new Error(
      "Release metadata must not contain credentials or signing material",
    );
  }
  const sbomPath = await findFirst(files, (filePath) =>
    filePath.toLowerCase().endsWith(".cdx.json"),
  );
  if (!sbomPath)
    throw new Error(
      "No CycloneDX .cdx.json SBOM was found in the input directory",
    );
  const sbomDocument = await readJson(sbomPath);
  if (sbomDocument.bomFormat !== "CycloneDX") {
    throw new Error("The release SBOM is not CycloneDX");
  }
  const counts = componentCounts(sbomDocument);
  for (const prefix of ["pkg:cargo/", "pkg:npm/"]) {
    if (!counts[prefix])
      throw new Error(`The release SBOM has no ${prefix} components`);
  }

  const artifacts = fragments
    .flatMap((fragment) => fragment.artifacts ?? [])
    .map((artifact) => ({
      ...artifact,
      platform: platformId(artifact.platform),
      path: archivePath(artifact.path),
      signaturePath: archivePath(artifact.signaturePath),
      symbols: Array.isArray(artifact.symbols)
        ? artifact.symbols.map(archivePath)
        : artifact.symbols,
    }));
  if (artifacts.length === 0)
    throw new Error("Release evidence fragments contain no artifacts");

  await verifyArtifactEvidence(artifacts, files, inputRoot);

  const sbomArchivePath = `artifacts/sbom/${options.version}/bx-ssh.cdx.json`;
  const sbomArchiveFile = path.resolve(
    path.dirname(outputPath),
    "..",
    "sbom",
    options.version,
    "bx-ssh.cdx.json",
  );
  await mkdir(path.dirname(sbomArchiveFile), { recursive: true });
  await cp(sbomPath, sbomArchiveFile, { force: true });

  const report = {
    schemaVersion: 1,
    version: options.version,
    channel: metadata.channel ?? channelForVersion(options.version),
    tag: metadata.tag ?? options.version,
    commit: options.commit,
    sourceBranch: metadata.sourceBranch ?? "main",
    generatedAt: metadata.generatedAt ?? new Date().toISOString(),
    tagVerification: metadata.tagVerification,
    suites: metadata.suites,
    defects: metadata.defects,
    artifacts,
    sbom: {
      format: "CycloneDX",
      fileFormat: "json",
      path: sbomArchivePath,
      sha256: await sha256File(sbomPath),
      retentionDays: metadata.sbom?.retentionDays ?? 90,
      componentCounts: counts,
    },
    licenses: metadata.licenses,
    signatures: metadata.signatures,
    reports: metadata.reports,
    provenance: metadata.provenance,
    result: metadata.result ?? "pass",
  };

  const suiteIds = new Set((report.suites ?? []).map((suite) => suite?.id));
  for (const suiteId of REQUIRED_SUITE_IDS) {
    if (!suiteIds.has(suiteId)) {
      throw new Error(
        `Release metadata is missing suite evidence for ${suiteId}`,
      );
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Release manifest written to ${outputPath}`);
}

async function existsDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function verifyArtifactEvidence(artifacts, files, inputRoot) {
  const normalizedFiles = files.map((filePath) => ({
    filePath,
    relative: path.relative(inputRoot, filePath).split(path.sep).join("/"),
  }));
  for (const artifact of artifacts) {
    const source = findDeclaredFile(artifact.path, normalizedFiles);
    if (!source) {
      throw new Error(
        `Release artifact is missing from downloaded evidence: ${artifact.path}`,
      );
    }
    const [actualSize, actualHash] = await Promise.all([
      stat(source.filePath).then((value) => value.size),
      sha256File(source.filePath),
    ]);
    if (
      Number.isInteger(artifact.sizeBytes) &&
      artifact.sizeBytes !== actualSize
    ) {
      throw new Error(`Release artifact size mismatch: ${artifact.path}`);
    }
    if (
      typeof artifact.sha256 === "string" &&
      artifact.sha256.toLowerCase() !== actualHash
    ) {
      throw new Error(`Release artifact SHA-256 mismatch: ${artifact.path}`);
    }
    for (const relatedPath of [
      artifact.signaturePath,
      artifact.installerSignatureEvidence,
      ...(Array.isArray(artifact.symbols) ? artifact.symbols : []),
    ]) {
      if (relatedPath && !findDeclaredFile(relatedPath, normalizedFiles)) {
        throw new Error(`Release artifact evidence is missing: ${relatedPath}`);
      }
    }
  }
}

function findDeclaredFile(declaredPath, files) {
  if (typeof declaredPath !== "string") return null;
  const suffix = declaredPath.replace(/^artifacts\//, "");
  const exact = files.find(
    ({ relative }) =>
      relative === declaredPath ||
      relative === suffix ||
      relative.endsWith(`/${suffix}`),
  );
  if (exact) return exact;
  const basename = path.posix.basename(declaredPath);
  const matches = files.filter(
    ({ relative }) => path.posix.basename(relative) === basename,
  );
  return matches.length === 1 ? matches[0] : null;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(
      `::error title=Release manifest generation failed::${message}`,
    );
  }
  process.exitCode = 1;
});
