import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const RELEASE_GATE_PATH = "quality/phase-1-release-gate.json";
export const MATRIX_PATH = "quality/phase-1-test-matrix.json";

const reviewedPaths = [
  "package.json",
  ".github/workflows/ci.yml",
  ".github/workflows/security.yml",
  ".github/workflows/package.yml",
  ".github/workflows/release.yml",
  "quality/phase-1-release-gate.json",
  "quality/phase-1-test-matrix.json",
  "GOVERNANCE.md",
  "security/supply-chain-policy.md",
  "security/risk-acceptance.md",
  "apps/desktop/src-tauri/tauri.conf.json",
  "scripts/prepare-release-evidence.mjs",
  "scripts/prepare-release-updater.mjs",
  "scripts/create-release-manifest.mjs",
  "scripts/sign-windows-bundles.ps1",
  "scripts/check-main-branch-protection.mjs",
  "Cargo.lock",
  "pnpm-lock.yaml",
];

const EXPECTED_SCRIPTS = {
  "release:controls": "node scripts/check-release-gate.mjs",
  "release:test": "node --test scripts/check-release-gate.test.mjs",
  "release:report":
    "node scripts/check-release-gate.mjs --report artifacts/release/release-manifest.json",
  "main-protection:test":
    "node --test scripts/check-main-branch-protection.test.mjs",
};

const REQUIRED_REPORT_FIELDS = [
  "suites",
  "defects",
  "artifacts",
  "sbom",
  "licenses",
  "signatures",
  "reports",
  "provenance",
];

export function loadReleaseGate(root = workspace) {
  return JSON.parse(readFileSync(path.join(root, RELEASE_GATE_PATH), "utf8"));
}

export function loadReviewedFiles(root = workspace) {
  return Object.fromEntries(
    reviewedPaths.map((relativePath) => [
      relativePath,
      readFileSync(path.join(root, relativePath), "utf8"),
    ]),
  );
}

/**
 * Validate the versioned release policy itself. This intentionally checks
 * semantics that JSON Schema alone cannot express (unique suite IDs,
 * supported tag expressions, and safe evidence locations).
 */
export function validateReleasePolicy(policy) {
  const violations = [];
  if (!isObject(policy)) {
    return ["release gate policy must be a JSON object"];
  }
  if (policy.schemaVersion !== 1) {
    violations.push("release gate policy schemaVersion must be 1");
  }
  if (policy.phase !== "P1") {
    violations.push("release gate policy phase must be P1");
  }
  for (const field of ["releaseName", "owner", "channel"]) {
    if (!nonEmptyString(policy[field])) {
      violations.push(
        `release gate policy ${field} must be a non-empty string`,
      );
    }
  }
  if (!["rc", "preview", "stable"].includes(policy.channel)) {
    violations.push(
      "release gate policy channel must be rc, preview, or stable",
    );
  }

  const source = policy.source;
  if (!isObject(source)) {
    violations.push("release gate policy source must be an object");
  } else {
    if (source.branch !== "main") {
      violations.push("release gate policy source.branch must be main");
    }
    for (const field of [
      "tagRequired",
      "annotatedTagRequired",
      "signedTagRequired",
      "immutableTagRequired",
    ]) {
      if (source[field] !== true) {
        violations.push(`release gate policy source.${field} must be true`);
      }
    }
    for (const field of ["tagPattern", "rcPattern"]) {
      if (!nonEmptyString(source[field])) {
        violations.push(`release gate policy source.${field} is required`);
        continue;
      }
      try {
        // Compile the expression now so a malformed policy cannot reach CI.
        new RegExp(source[field]);
      } catch {
        violations.push(
          `release gate policy source.${field} must be a valid regular expression`,
        );
      }
    }
  }

  const requiredSuites = policy.requiredSuites;
  if (!Array.isArray(requiredSuites) || requiredSuites.length === 0) {
    violations.push(
      "release gate policy requiredSuites must be a non-empty array",
    );
  } else {
    if (new Set(requiredSuites).size !== requiredSuites.length) {
      violations.push("release gate policy requiredSuites must be unique");
    }
    for (const suiteId of requiredSuites) {
      if (!/^QA-[A-Z]+-\d{2}$/.test(suiteId)) {
        violations.push(
          `release gate policy requiredSuites contains invalid suite id: ${String(suiteId)}`,
        );
      }
    }
  }

  const defects = policy.defects;
  if (!isObject(defects)) {
    violations.push("release gate policy defects must be an object");
  } else {
    if (
      !Array.isArray(defects.blockingLevels) ||
      defects.blockingLevels.length === 0 ||
      defects.blockingLevels.some(
        (level) => !["P0", "P1", "P2", "P3"].includes(level),
      )
    ) {
      violations.push(
        "release gate policy defects.blockingLevels must contain valid P0-P3 levels",
      );
    }
    if (defects.maximumOpenBlocking !== 0) {
      violations.push(
        "release gate policy defects.maximumOpenBlocking must be zero",
      );
    }
    if (
      !Array.isArray(defects.dispositionRequiredFor) ||
      defects.dispositionRequiredFor.some(
        (level) => !["P0", "P1", "P2", "P3"].includes(level),
      )
    ) {
      violations.push(
        "release gate policy defects.dispositionRequiredFor must contain valid P0-P3 levels",
      );
    }
  }

  const supplyChain = policy.supplyChain;
  if (!isObject(supplyChain)) {
    violations.push("release gate policy supplyChain must be an object");
  } else {
    const sbom = supplyChain.sbom;
    if (!isObject(sbom)) {
      violations.push("release gate policy supplyChain.sbom must be an object");
    } else {
      if (sbom.format !== "CycloneDX") {
        violations.push("release gate policy SBOM format must be CycloneDX");
      }
      if (sbom.fileFormat !== "json") {
        violations.push("release gate policy SBOM fileFormat must be json");
      }
      if (
        !Array.isArray(sbom.requiredComponentPurlPrefixes) ||
        sbom.requiredComponentPurlPrefixes.length < 2 ||
        sbom.requiredComponentPurlPrefixes.some(
          (prefix) => !nonEmptyString(prefix),
        )
      ) {
        violations.push(
          "release gate policy SBOM must require Cargo and npm component prefixes",
        );
      }
      if (!positiveInteger(sbom.minimumRetentionDays)) {
        violations.push(
          "release gate policy SBOM minimumRetentionDays must be positive",
        );
      }
      if (!pathPrefix(sbom.pathPrefix, "artifacts/sbom/")) {
        violations.push(
          "release gate policy SBOM pathPrefix must be under artifacts/sbom/",
        );
      }
    }
    if (
      !Array.isArray(supplyChain.licenseCommands) ||
      supplyChain.licenseCommands.length < 2 ||
      supplyChain.licenseCommands.some((command) => !nonEmptyString(command))
    ) {
      violations.push(
        "release gate policy supplyChain.licenseCommands must contain commands",
      );
    }
    const secretScan = supplyChain.secretScan;
    if (!isObject(secretScan) || secretScan.tool !== "gitleaks") {
      violations.push(
        "release gate policy supplyChain.secretScan.tool must be gitleaks",
      );
    } else if (secretScan.fullHistoryRequired !== true) {
      violations.push(
        "release gate policy supplyChain.secretScan.fullHistoryRequired must be true",
      );
    }
    if (
      !Array.isArray(supplyChain.lockfiles) ||
      !supplyChain.lockfiles.includes("Cargo.lock") ||
      !supplyChain.lockfiles.includes("pnpm-lock.yaml")
    ) {
      violations.push(
        "release gate policy supplyChain.lockfiles must include Cargo.lock and pnpm-lock.yaml",
      );
    }
  }

  const artifacts = policy.artifacts;
  if (!isObject(artifacts)) {
    violations.push("release gate policy artifacts must be an object");
  } else {
    if (!positiveInteger(artifacts.retentionDays)) {
      violations.push(
        "release gate policy artifacts.retentionDays must be positive",
      );
    }
    if (artifacts.hashAlgorithm !== "SHA-256") {
      violations.push(
        "release gate policy artifacts.hashAlgorithm must be SHA-256",
      );
    }
    if (
      !Array.isArray(artifacts.requiredEvidencePrefixes) ||
      artifacts.requiredEvidencePrefixes.length === 0 ||
      artifacts.requiredEvidencePrefixes.some(
        (prefix) => !nonEmptyString(prefix),
      )
    ) {
      violations.push(
        "release gate policy artifacts.requiredEvidencePrefixes must contain paths",
      );
    }
    if (
      !Array.isArray(artifacts.validationPlatforms) ||
      artifacts.validationPlatforms.length === 0 ||
      artifacts.validationPlatforms.some(
        (platform) => !nonEmptyString(platform),
      )
    ) {
      violations.push(
        "release gate policy artifacts.validationPlatforms must contain platforms",
      );
    }
    const releasePlatforms = artifacts.releasePlatforms;
    if (!Array.isArray(releasePlatforms) || releasePlatforms.length === 0) {
      violations.push(
        "release gate policy artifacts.releasePlatforms must be a non-empty array",
      );
    } else {
      const platformIds = releasePlatforms.map((platform) => platform?.id);
      if (new Set(platformIds).size !== platformIds.length) {
        violations.push(
          "release gate policy release platform IDs must be unique",
        );
      }
      for (const platform of releasePlatforms) {
        if (!isObject(platform)) {
          violations.push(
            "release gate policy release platform must be an object",
          );
          continue;
        }
        for (const field of [
          "id",
          "runner",
          "installerSigning",
          "updaterSigning",
        ]) {
          if (!nonEmptyString(platform[field])) {
            violations.push(
              `release platform ${platform.id ?? "<unknown>"} ${field} is required`,
            );
          }
        }
        if (platform.required !== true) {
          violations.push(
            `release platform ${platform.id ?? "<unknown>"} must be required`,
          );
        }
        for (const field of [
          "bundleTypes",
          "signatureExtensions",
          "symbolExtensions",
        ]) {
          if (
            !Array.isArray(platform[field]) ||
            platform[field].length === 0 ||
            platform[field].some((value) => !nonEmptyString(value))
          ) {
            violations.push(
              `release platform ${platform.id ?? "<unknown>"} ${field} must contain values`,
            );
          }
        }
      }
    }
  }

  const signing = policy.signing;
  if (!isObject(signing)) {
    violations.push("release gate policy signing must be an object");
  } else {
    if (
      !Array.isArray(signing.privateKeySources) ||
      !signing.privateKeySources.includes("github-environment") ||
      !signing.privateKeySources.includes("offline-release-host")
    ) {
      violations.push(
        "release gate policy signing.privateKeySources must restrict keys to protected sources",
      );
    }
    if (signing.privateKeyMustNotBeArchived !== true) {
      violations.push(
        "release gate policy signing.privateKeyMustNotBeArchived must be true",
      );
    }
    const requiredChecks = signing.requiredChecks;
    if (
      !Array.isArray(requiredChecks) ||
      requiredChecks.length < 5 ||
      requiredChecks.some((check) => !nonEmptyString(check))
    ) {
      violations.push(
        "release gate policy signing.requiredChecks must list installer, updater, tamper, wrong-key, and downgrade checks",
      );
    }
  }

  const traceability = policy.traceability;
  if (!isObject(traceability)) {
    violations.push("release gate policy traceability must be an object");
  } else {
    if (traceability.manifestSchemaVersion !== 1) {
      violations.push(
        "release gate policy traceability.manifestSchemaVersion must be 1",
      );
    }
    for (const field of ["requiredReleaseFields", "requiredReportFields"]) {
      if (
        !Array.isArray(traceability[field]) ||
        traceability[field].length === 0 ||
        traceability[field].some((value) => !nonEmptyString(value))
      ) {
        violations.push(
          `release gate policy traceability.${field} must contain field names`,
        );
      }
    }
    for (const field of REQUIRED_REPORT_FIELDS) {
      if (!traceability.requiredReportFields?.includes(field)) {
        violations.push(
          `release gate policy traceability.requiredReportFields must include ${field}`,
        );
      }
    }
  }

  if (
    !Array.isArray(policy.requiredEvidence) ||
    policy.requiredEvidence.length === 0 ||
    policy.requiredEvidence.some((evidence) => !nonEmptyString(evidence))
  ) {
    violations.push("release gate policy requiredEvidence must contain text");
  }

  return violations;
}

/**
 * Validate that source control and CI actually implement the versioned
 * release policy. The check is deliberately text-oriented because adding a
 * YAML parser to the production toolchain would create an unnecessary
 * dependency; each assertion targets a stable, reviewable workflow contract.
 */
export function validateReleaseGateControls(files) {
  const violations = [];
  const source = (relativePath) => files[relativePath] ?? "";
  const requireText = (relativePath, pattern, description) => {
    if (!pattern.test(source(relativePath))) {
      violations.push(`${relativePath} is missing ${description}`);
    }
  };

  const policy = parseJson(
    source(RELEASE_GATE_PATH),
    RELEASE_GATE_PATH,
    violations,
  );
  violations.push(...validateReleasePolicy(policy));

  const packageJson = parseJson(
    source("package.json"),
    "package.json",
    violations,
  );
  for (const [script, expectedCommand] of Object.entries(EXPECTED_SCRIPTS)) {
    if (packageJson?.scripts?.[script] !== expectedCommand) {
      violations.push(`package.json ${script} must run the reviewed command`);
    }
  }
  const workspaceCheck = packageJson?.scripts?.check ?? "";
  for (const command of [
    "pnpm release:controls",
    "pnpm release:test",
    "pnpm main-protection:test",
  ]) {
    if (!workspaceCheck.includes(command)) {
      violations.push(`package.json check must include ${command}`);
    }
  }

  const matrix = parseJson(source(MATRIX_PATH), MATRIX_PATH, violations);
  const requiredSuites = Array.isArray(policy?.requiredSuites)
    ? policy.requiredSuites
    : [];
  const matrixSuites = matrix?.testSuites;
  if (!Array.isArray(matrixSuites)) {
    violations.push(
      "quality matrix testSuites must be an array for release validation",
    );
  } else {
    const releaseSuite = matrixSuites.find(
      (suite) => suite?.id === "QA-REL-01",
    );
    if (!releaseSuite) {
      violations.push("quality matrix is missing QA-REL-01");
    } else {
      if (releaseSuite.category !== "release") {
        violations.push("QA-REL-01 must have the release category");
      }
      if (releaseSuite.blocking !== "release") {
        violations.push("QA-REL-01 must be release-blocking");
      }
      for (const command of [
        "pnpm release:controls",
        "pnpm release:test",
        "pnpm main-protection:test",
      ]) {
        if (!releaseSuite.commands?.some((entry) => entry?.run === command)) {
          violations.push(`QA-REL-01 is missing ${command}`);
        }
      }
      if (
        !releaseSuite.commands?.some(
          (entry) => entry?.run === "pnpm release:report",
        )
      ) {
        violations.push("QA-REL-01 must document pnpm release:report");
      }
      for (const pattern of [/SBOM/i, /签名/, /RC|发布候选/, /SHA-256/i]) {
        if (!releaseSuite.manualChecks?.some((check) => pattern.test(check))) {
          violations.push(`QA-REL-01 manual checks are missing ${pattern}`);
        }
      }
      if (
        !releaseSuite.artifacts?.some((artifact) =>
          /artifacts\/release/.test(artifact),
        )
      ) {
        violations.push(
          "QA-REL-01 must archive release manifests under artifacts/release/",
        );
      }
      if (
        !releaseSuite.artifacts?.some((artifact) =>
          /artifacts\/sbom/.test(artifact),
        )
      ) {
        violations.push("QA-REL-01 must archive an SBOM");
      }
    }
    for (const suiteId of requiredSuites) {
      const suite = matrixSuites.find((candidate) => candidate?.id === suiteId);
      if (!suite) {
        violations.push(
          `quality matrix is missing required release suite ${suiteId}`,
        );
      } else if (suite.blocking !== "release") {
        violations.push(
          `required release suite ${suiteId} must be release-blocking`,
        );
      }
    }
  }

  const ci = source(".github/workflows/ci.yml");
  requireText(
    ".github/workflows/ci.yml",
    /pull_request:/,
    "pull-request trigger",
  );
  requireText(
    ".github/workflows/ci.yml",
    /branches:\s*\n\s*- main/,
    "main branch push trigger",
  );
  requireText(
    ".github/workflows/ci.yml",
    /release-gate:/,
    "the release-gate job",
  );
  requireText(
    ".github/workflows/ci.yml",
    /run:\s*pnpm release:controls/,
    "release control execution",
  );
  requireText(
    ".github/workflows/ci.yml",
    /run:\s*pnpm release:test/,
    "release control test execution",
  );
  if (
    ci.includes("release-gate:") &&
    !/needs:\s*\[[^\]]*(?:quality-policy|frontend|rust)/s.test(ci)
  ) {
    violations.push(
      ".github/workflows/ci.yml release-gate must depend on the core CI jobs",
    );
  }

  const security = source(".github/workflows/security.yml");
  for (const [pattern, description] of [
    [/cargo deny check advisories licenses sources/, "cargo-deny checks"],
    [/pnpm audit[^\n]*--audit-level high/, "high-severity npm audit"],
    [/check-npm-licenses\.mjs --production/, "production license check"],
    [/check-npm-licenses\.mjs(?! --production)/, "development license check"],
    [/gitleaks git \. --redact --exit-code 1/, "full-history Gitleaks scan"],
    [/syft dir:\. --output cyclonedx-json=/, "CycloneDX SBOM generation"],
    [/actions\/upload-artifact@[0-9a-f]{40}/, "pinned SBOM artifact upload"],
    [/retention-days:\s*14/, "SBOM retention policy"],
  ]) {
    if (!pattern.test(security)) {
      violations.push(
        `.github/workflows/security.yml is missing ${description}`,
      );
    }
  }

  const packaging = source(".github/workflows/package.yml");
  for (const [pattern, description] of [
    [/windows-2025/, "Windows release runner"],
    [/macos-14/, "macOS validation runner"],
    [/ubuntu-24\.04/, "Linux validation runner"],
    [/tauri build/, "Tauri bundle build"],
    [/check-windows-packaging/, "Windows packaging policy check"],
    [/bx-update-validator/, "signed updater validation"],
    [/bundle-size/, "bundle-size report"],
    [/\.sig/, "updater signature archive"],
    [/\.pdb/, "Windows symbol archive"],
    [/artifacts\/release/, "versioned release evidence path"],
    [/retention-days:\s*90/, "release artifact retention policy"],
  ]) {
    if (!pattern.test(packaging)) {
      violations.push(
        `.github/workflows/package.yml is missing ${description}`,
      );
    }
  }
  if (
    /path:[\s\S]*TAURI_SIGNING_PRIVATE_KEY/.test(packaging) ||
    /path:[\s\S]*\.key/.test(packaging)
  ) {
    violations.push("package workflow must never upload signing private keys");
  }

  const release = source(".github/workflows/release.yml");
  for (const [pattern, description] of [
    [/tags:\s*\n\s*- ['"]?v\*/s, "version tag trigger"],
    [/workflow_dispatch:/, "manual RC dispatch"],
    [
      /source_commit:\s*\$\{\{ steps\.verify_release_tag\.outputs\.commit \}\}/,
      "verified source-commit output",
    ],
    [/permissions:\s*\n\s+contents:\s*write/s, "release write permission"],
    [/environment:\s*release/, "protected release environment"],
    [/pnpm release:controls/, "release control preflight"],
    [/pnpm release:test/, "release control tests"],
    [/pnpm main-protection:test/, "main branch protection validator tests"],
    [/Verify main branch protection/, "main branch protection verification"],
    [/branches\/main\/protection/, "GitHub branch protection API check"],
    [/BRANCH_PROTECTION_TOKEN/, "protected branch-protection read token"],
    [
      /RELEASE_TAG_SIGNING_PUBLIC_KEY/,
      "protected release-tag verification key",
    ],
    [/gpg --batch[^\n]*--import/, "release-tag public-key import"],
    [/check-main-branch-protection\.mjs/, "main branch protection validator"],
    [/pnpm release:report/, "release manifest validation"],
    [/create-release-manifest\.mjs/, "release manifest generation"],
    [/RELEASE_METADATA_JSON/, "protected QA acceptance metadata"],
    [/prepare-release-updater\.mjs/, "release updater configuration"],
    [
      /--config [^\n]*tauri\.release\.conf\.json/,
      "signed updater build configuration",
    ],
    [/sign-windows-bundles\.ps1/, "Windows Authenticode signing"],
    [/windows-signature-report\.json/, "Windows signature evidence report"],
    [/tauri signer sign/, "post-Authenticode updater re-signing"],
    [/gh release create/, "versioned GitHub release publication"],
    [/Stage uniquely named release assets/, "collision-free release assets"],
    [/artifacts\/publish-assets/, "uniquely named release asset staging"],
    [
      /artifacts\/release\/\$RELEASE_VERSION\/release-manifest\.json/,
      "versioned release manifest copy",
    ],
    [/artifacts\/sbom/, "SBOM release asset"],
    [/actions\/upload-artifact@[0-9a-f]{40}/, "pinned release artifact upload"],
  ]) {
    if (!pattern.test(release)) {
      violations.push(
        `.github/workflows/release.yml is missing ${description}`,
      );
    }
  }
  const checkoutCount = (
    release.match(/uses:\s*actions\/checkout@[0-9a-f]{40}/g) ?? []
  ).length;
  const releaseRefCheckoutCount = (
    release.match(/ref:\s*\$\{\{ inputs\.version \|\| github\.ref \}\}/g) ?? []
  ).length;
  if (checkoutCount === 0 || releaseRefCheckoutCount !== checkoutCount) {
    violations.push(
      ".github/workflows/release.yml must check out the verified release tag in every job",
    );
  }
  if (
    !release.includes(
      '--commit "${{ needs.release-gate.outputs.source_commit }}"',
    )
  ) {
    violations.push(
      ".github/workflows/release.yml must build the manifest from the verified tag commit",
    );
  }

  const branchProtection = source("scripts/check-main-branch-protection.mjs");
  for (const [pattern, description] of [
    [/required_status_checks/, "required status checks"],
    [/required_pull_request_reviews/, "pull-request review requirement"],
    [/enforce_admins/, "administrator protection"],
    [/required_linear_history/, "linear history requirement"],
    [/required_conversation_resolution/, "conversation resolution requirement"],
    [/allow_force_pushes/, "force-push prohibition"],
    [/allow_deletions/, "branch deletion prohibition"],
  ]) {
    if (!pattern.test(branchProtection)) {
      violations.push(
        `scripts/check-main-branch-protection.mjs is missing ${description}`,
      );
    }
  }
  if (
    /path:[\s\S]*TAURI_SIGNING_PRIVATE_KEY/.test(release) ||
    /path:[\s\S]*WINDOWS_CODESIGN_CERTIFICATE/.test(release)
  ) {
    violations.push(
      "release workflow must never upload signing private keys or certificate secrets",
    );
  }

  for (const [relativePath, description] of [
    ["scripts/prepare-release-evidence.mjs", "release evidence collector"],
    [
      "scripts/prepare-release-updater.mjs",
      "release updater configuration generator",
    ],
    ["scripts/create-release-manifest.mjs", "release manifest generator"],
    ["scripts/sign-windows-bundles.ps1", "Windows Authenticode signing script"],
  ]) {
    if (!nonEmptyString(source(relativePath))) {
      violations.push(`${relativePath} is missing the ${description}`);
    }
  }

  for (const workflowPath of [
    ".github/workflows/ci.yml",
    ".github/workflows/security.yml",
    ".github/workflows/package.yml",
    ".github/workflows/release.yml",
  ]) {
    const workflow = source(workflowPath);
    const unpinned = workflow
      .split(/\r?\n/)
      .filter((line) => /\buses:\s*[^@\s]+@/.test(line))
      .filter((line) => !/@[0-9a-f]{40}\b/.test(line));
    if (unpinned.length > 0) {
      violations.push(`${workflowPath} contains an unpinned GitHub Action`);
    }
  }

  const tauri = parseJson(
    source("apps/desktop/src-tauri/tauri.conf.json"),
    "apps/desktop/src-tauri/tauri.conf.json",
    violations,
  );
  if (tauri?.identifier !== "io.github.baoxue2026.bx-ssh") {
    violations.push(
      "Tauri application identifier must remain stable for releases",
    );
  }
  if (tauri?.bundle?.windows?.allowDowngrades !== false) {
    violations.push("Tauri Windows bundles must reject downgrades");
  }
  if (tauri?.plugins?.updater?.windows?.installMode !== "passive") {
    violations.push("Tauri Windows updater must use passive install mode");
  }
  if (
    !nonEmptyString(tauri?.plugins?.updater?.pubkey) ||
    !tauri?.plugins?.updater?.endpoints?.some((endpoint) =>
      /^https:\/\//.test(endpoint),
    )
  ) {
    violations.push(
      "Tauri updater must define an HTTPS endpoint and public key",
    );
  }

  for (const requiredPath of ["Cargo.lock", "pnpm-lock.yaml"]) {
    if (!nonEmptyString(source(requiredPath))) {
      violations.push(
        `${requiredPath} must be committed for reproducible releases`,
      );
    }
  }
  const governance = source("GOVERNANCE.md");
  for (const [pattern, description] of [
    [
      /Release tags are annotated, signed, immutable/,
      "annotated signed immutable tags",
    ],
    [
      /Build artifacts, SBOMs, signatures, symbols, and test reports/,
      "versioned evidence archival rule",
    ],
    [/P0 and P1 defects block releases/, "blocking defect rule"],
  ]) {
    if (!pattern.test(governance)) {
      violations.push(`GOVERNANCE.md is missing ${description}`);
    }
  }
  const supplyPolicy = source("security/supply-chain-policy.md");
  for (const [pattern, description] of [
    [/CycloneDX JSON SBOM/, "CycloneDX SBOM requirement"],
    [
      /Release signing private keys may only come from a GitHub Environment secret/,
      "protected signing-key source",
    ],
    [
      /must not be written to the repository, artifacts, caches, or ordinary logs/,
      "signing-key non-archival rule",
    ],
  ]) {
    if (!pattern.test(supplyPolicy)) {
      violations.push(
        `security/supply-chain-policy.md is missing ${description}`,
      );
    }
  }
  if (!nonEmptyString(source("security/risk-acceptance.md"))) {
    violations.push(
      "security/risk-acceptance.md must be present for RC risk disposition",
    );
  }

  return violations;
}

/**
 * Validate a release evidence manifest produced by the protected RC workflow.
 * The manifest is intentionally self-contained so a downloaded release bundle
 * can be audited without relying on mutable CI UI state.
 */
export function validateReleaseReport(report, policy = loadReleaseGate()) {
  const effectivePolicy = isObject(policy) ? policy : {};
  const violations = validateReleasePolicy(policy);
  if (!isObject(report)) {
    return [...violations, "release report must be a JSON object"];
  }
  if (
    report.schemaVersion !== effectivePolicy.traceability?.manifestSchemaVersion
  ) {
    violations.push("release report schemaVersion does not match the policy");
  }
  for (const field of effectivePolicy.traceability?.requiredReleaseFields ??
    []) {
    if (!nonEmptyString(report[field])) {
      violations.push(`release report ${field} is required for traceability`);
    }
  }

  const source = effectivePolicy.source ?? {};
  if (nonEmptyString(report.version)) {
    if (!matchesRegex(report.version, source.tagPattern)) {
      violations.push(
        "release report version must match the release tag pattern",
      );
    }
    const channel = channelForVersion(report.version);
    const expectedChannel = effectivePolicy.channel ?? channel;
    if (report.channel !== expectedChannel) {
      violations.push(
        `release report channel must be ${expectedChannel} for this release policy`,
      );
    }
    if (
      expectedChannel === "rc" &&
      !matchesRegex(report.version, source.rcPattern)
    ) {
      violations.push("release report version must match the RC tag pattern");
    }
  }
  if (nonEmptyString(report.tag) && report.tag !== report.version) {
    violations.push("release report tag must equal version");
  }
  if (
    nonEmptyString(report.sourceBranch) &&
    report.sourceBranch !== source.branch
  ) {
    violations.push("release report sourceBranch must be main");
  }
  if (nonEmptyString(report.commit) && !/^[0-9a-f]{40}$/i.test(report.commit)) {
    violations.push("release report commit must be a 40-character Git SHA");
  }
  if (!validUtcTimestamp(report.generatedAt)) {
    violations.push("release report generatedAt must be a valid UTC timestamp");
  }

  const tagVerification = report.tagVerification;
  if (!isObject(tagVerification)) {
    violations.push("release report tagVerification must be an object");
  } else {
    for (const field of ["annotated", "signed", "immutable"]) {
      if (tagVerification[field] !== true) {
        violations.push(`release report tagVerification.${field} must be true`);
      }
    }
  }

  const requiredSuites = Array.isArray(effectivePolicy.requiredSuites)
    ? effectivePolicy.requiredSuites
    : [];
  const suites = report.suites;
  if (!Array.isArray(suites)) {
    violations.push("release report suites must be an array");
  } else {
    const suiteIds = suites.map((suite) => suite?.id);
    const allowedSuiteIds = new Set(requiredSuites);
    for (const requiredSuite of requiredSuites) {
      if (!suiteIds.includes(requiredSuite)) {
        violations.push(
          `release report is missing suite evidence for ${requiredSuite}`,
        );
      }
    }
    if (new Set(suiteIds).size !== suiteIds.length) {
      violations.push("release report suites must have unique IDs");
    }
    for (const suite of suites) {
      if (!isObject(suite) || !nonEmptyString(suite.id)) {
        violations.push("release report suite entries must identify a suite");
        continue;
      }
      if (!allowedSuiteIds.has(suite.id)) {
        violations.push(
          `release report contains an unregistered suite ${suite.id}`,
        );
      }
      if (suite.status !== "pass") {
        violations.push(
          `release report suite ${suite.id} must have pass status`,
        );
      }
      if (!evidencePath(suite.evidence)) {
        violations.push(
          `release report suite ${suite.id} must reference archived evidence`,
        );
      }
    }
  }

  const defects = report.defects;
  if (!isObject(defects)) {
    violations.push("release report defects must be an object");
  } else {
    const open = defects.open;
    if (!isObject(open)) {
      violations.push("release report defects.open must be an object");
    } else {
      for (const level of ["P0", "P1", "P2", "P3"]) {
        if (!nonNegativeInteger(open[level])) {
          violations.push(
            `release report defects.open.${level} must be a non-negative integer`,
          );
        }
      }
      for (const level of effectivePolicy.defects?.blockingLevels ?? [
        "P0",
        "P1",
      ]) {
        if (
          nonNegativeInteger(open[level]) &&
          open[level] > (effectivePolicy.defects?.maximumOpenBlocking ?? 0)
        ) {
          violations.push(
            `release report defects.open.${level} exceeds the blocking limit`,
          );
        }
      }
    }
    const dispositions = defects.dispositions;
    if (!isObject(dispositions)) {
      violations.push("release report defects.dispositions must be an object");
    } else {
      for (const level of effectivePolicy.defects?.dispositionRequiredFor ?? [
        "P2",
        "P3",
      ]) {
        const count = defects.open?.[level];
        if (
          nonNegativeInteger(count) &&
          count > 0 &&
          !nonEmptyString(dispositions[level])
        ) {
          violations.push(
            `release report defects.dispositions.${level} is required when defects remain open`,
          );
        }
      }
    }
  }

  validateArtifacts(report.artifacts, effectivePolicy, violations);
  validateSbom(report.sbom, effectivePolicy, violations);
  validateLicenses(report.licenses, violations);
  validateSignatures(report.signatures, effectivePolicy, violations);
  validateReports(report.reports, effectivePolicy, violations);
  validateProvenance(report.provenance, violations);

  if (report.result !== "pass") {
    violations.push("release report result must be pass");
  }
  return violations;
}

function validateArtifacts(artifactList, policy, violations) {
  if (!Array.isArray(artifactList) || artifactList.length === 0) {
    violations.push("release report artifacts must be a non-empty array");
    return;
  }
  const platforms = new Map();
  const allowedPlatformIds = new Set([
    ...(policy.artifacts?.releasePlatforms ?? []).map(
      (platform) => platform?.id,
    ),
    ...(policy.artifacts?.validationPlatforms ?? []),
  ]);
  for (const artifact of artifactList) {
    if (!isObject(artifact)) {
      violations.push("release report artifact entries must be objects");
      continue;
    }
    for (const field of ["platform", "type", "path"]) {
      if (!nonEmptyString(artifact[field])) {
        violations.push(`release report artifact ${field} is required`);
      }
    }
    if (!allowedPlatformIds.has(artifact.platform)) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} uses an unregistered platform`,
      );
    }
    if (!evidencePath(artifact.path, "artifacts/release/")) {
      violations.push(
        `release report artifact path must be under artifacts/release/: ${artifact.path ?? "<missing>"}`,
      );
    }
    if (!sha256(artifact.sha256)) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} must include a SHA-256 hash`,
      );
    }
    if (!positiveInteger(artifact.sizeBytes)) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} must include a positive size`,
      );
    }
    if (
      hasSecretExtension(artifact.path) ||
      hasSecretExtension(artifact.signaturePath)
    ) {
      violations.push(
        "release report must not archive private signing material",
      );
    }
    if (artifact.signed !== true) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} must be signed`,
      );
    }
    if (!evidencePath(artifact.signaturePath, "artifacts/release/")) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} must reference its signature`,
      );
    }
    const platformPolicy = policy.artifacts?.releasePlatforms?.find(
      (candidate) => candidate?.id === artifact.platform,
    );
    const symbolsRequired = platformPolicy?.required === true;
    if (
      symbolsRequired &&
      (!Array.isArray(artifact.symbols) || artifact.symbols.length === 0)
    ) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} must reference archived symbols`,
      );
    } else if (
      Array.isArray(artifact.symbols) &&
      artifact.symbols.some(
        (symbol) => !evidencePath(symbol, "artifacts/release/"),
      )
    ) {
      violations.push(
        `release report artifact ${artifact.path ?? "<missing>"} has a symbol outside artifacts/release/`,
      );
    }
    if (
      artifact.platform === "windows-x64" &&
      ["msi", "nsis"].includes(artifact.type)
    ) {
      if (artifact.installerSigned !== true) {
        violations.push(
          `release report artifact ${artifact.path ?? "<missing>"} must have a valid Authenticode signature`,
        );
      }
      if (
        !evidencePath(artifact.installerSignatureEvidence, "artifacts/release/")
      ) {
        violations.push(
          `release report artifact ${artifact.path ?? "<missing>"} must reference Authenticode evidence`,
        );
      }
    }
    const key = `${artifact.platform}:${artifact.type}`;
    if (platforms.has(key)) {
      violations.push(`release report contains duplicate artifact ${key}`);
    }
    platforms.set(key, artifact);
  }

  for (const platform of policy.artifacts?.releasePlatforms ?? []) {
    for (const type of platform.bundleTypes ?? []) {
      const artifact = platforms.get(`${platform.id}:${type}`);
      if (!artifact) {
        violations.push(
          `release report is missing ${platform.id} ${type} artifact`,
        );
      }
    }
  }
}

function validateSbom(sbom, policy, violations) {
  if (!isObject(sbom)) {
    violations.push("release report sbom must be an object");
    return;
  }
  const expected = policy.supplyChain?.sbom ?? {};
  if (sbom.format !== expected?.format) {
    violations.push("release report sbom.format must be CycloneDX");
  }
  if (sbom.fileFormat !== expected?.fileFormat) {
    violations.push("release report sbom.fileFormat must be json");
  }
  if (!evidencePath(sbom.path, expected?.pathPrefix)) {
    violations.push(
      "release report sbom.path must be under the SBOM archive prefix",
    );
  }
  if (!sha256(sbom.sha256)) {
    violations.push("release report sbom.sha256 must be a SHA-256 hash");
  }
  if (
    !positiveInteger(sbom.retentionDays) ||
    !positiveInteger(expected.minimumRetentionDays) ||
    sbom.retentionDays < expected.minimumRetentionDays
  ) {
    violations.push(
      "release report sbom.retentionDays is below the policy minimum",
    );
  }
  for (const prefix of expected.requiredComponentPurlPrefixes ?? []) {
    if (!positiveInteger(sbom.componentCounts?.[prefix])) {
      violations.push(
        `release report SBOM must contain components with prefix ${prefix}`,
      );
    }
  }
}

function validateLicenses(licenses, violations) {
  if (!isObject(licenses)) {
    violations.push("release report licenses must be an object");
    return;
  }
  for (const field of ["rust", "productionNpm", "developmentNpm", "audit"]) {
    if (licenses[field] !== "pass") {
      violations.push(`release report licenses.${field} must be pass`);
    }
  }
  if (!evidencePath(licenses.evidence)) {
    violations.push(
      "release report licenses.evidence must reference archived evidence",
    );
  }
}

function validateSignatures(signatures, policy, violations) {
  if (!isObject(signatures)) {
    violations.push("release report signatures must be an object");
    return;
  }
  const requiredChecks = policy.signing?.requiredChecks ?? [];
  const aliases = {
    "installer-signature": "installer",
    "updater-signature": "updater",
    "tamper-rejection": "tamperRejected",
    "wrong-key-rejection": "wrongKeyRejected",
    "downgrade-rejection": "downgradeRejected",
  };
  for (const check of requiredChecks) {
    const field = aliases[check] ?? check;
    if (signatures[field] !== true) {
      violations.push(`release report signatures.${field} must be true`);
    }
  }
  if (!evidencePath(signatures.evidence)) {
    violations.push(
      "release report signatures.evidence must reference archived evidence",
    );
  }
}

function validateReports(reports, policy, violations) {
  if (!isObject(reports)) {
    violations.push("release report reports must be an object");
    return;
  }
  for (const field of [
    "tests",
    "bundleSizes",
    "updateValidation",
    "security",
    "stability",
    "performance",
  ]) {
    if (!evidencePath(reports[field])) {
      violations.push(
        `release report reports.${field} must reference archived evidence`,
      );
    }
  }
  const prefixes = policy.artifacts?.requiredEvidencePrefixes ?? [];
  for (const [field, value] of Object.entries(reports)) {
    if (!nonEmptyString(value)) continue;
    if (!prefixes.some((prefix) => value.startsWith(prefix))) {
      violations.push(
        `release report reports.${field} must use an approved evidence prefix`,
      );
    }
  }
}

function validateProvenance(provenance, violations) {
  if (!isObject(provenance)) {
    violations.push("release report provenance must be an object");
    return;
  }
  for (const field of ["workflow", "workflowRun", "repository", "runner"]) {
    if (!nonEmptyString(provenance[field])) {
      violations.push(`release report provenance.${field} is required`);
    }
  }
  if (
    hasSecretExtension(provenance.workflowRun) ||
    hasSecretExtension(provenance.runner)
  ) {
    violations.push(
      "release report provenance must not expose signing material",
    );
  }
}

function parseJson(value, label, violations) {
  try {
    return JSON.parse(value);
  } catch {
    violations.push(`${label} must contain valid JSON`);
    return null;
  }
}

function matchesRegex(value, expression) {
  if (!nonEmptyString(expression)) return false;
  try {
    return new RegExp(expression).test(value);
  } catch {
    return false;
  }
}

function channelForVersion(version) {
  if (/-rc\.\d+$/.test(version)) return "rc";
  if (/-(?:alpha|beta)\.\d+$/.test(version)) return "preview";
  return "stable";
}

function validUtcTimestamp(value) {
  return (
    nonEmptyString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function evidencePath(value, requiredPrefix = null) {
  if (!nonEmptyString(value)) return false;
  if (value.includes("..") || value.includes("\\")) return false;
  if (!value.startsWith("artifacts/")) return false;
  return requiredPrefix === null || value.startsWith(requiredPrefix);
}

function pathPrefix(value, expectedPrefix) {
  return nonEmptyString(value) && value.startsWith(expectedPrefix);
}

function sha256(value) {
  return nonEmptyString(value) && /^[0-9a-f]{64}$/i.test(value);
}

function hasSecretExtension(value) {
  return (
    nonEmptyString(value) &&
    /(?:^|[./\\])(?:[^/\\]+\.(?:key|pem|p12|pfx|jks|keystore|tauri\.key))(?:$|[./\\])/i.test(
      value,
    )
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isMain() {
  return (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

function parseArguments(argv) {
  let reportPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--report" || !argv[index + 1]) {
      throw new Error(
        `Usage: node scripts/check-release-gate.mjs [--report <path>]`,
      );
    }
    reportPath = argv[index + 1];
    index += 1;
  }
  return { reportPath };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const files = loadReviewedFiles();
  const controls = validateReleaseGateControls(files);
  let reportViolations = [];
  if (options.reportPath) {
    let report = null;
    try {
      report = JSON.parse(
        readFileSync(path.resolve(options.reportPath), "utf8"),
      );
    } catch {
      reportViolations.push(
        `release report file does not exist or is invalid: ${options.reportPath}`,
      );
    }
    reportViolations.push(...validateReleaseReport(report, loadReleaseGate()));
  }
  const violations = [...controls, ...reportViolations];
  if (violations.length > 0) {
    console.error("Release gate check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    options.reportPath
      ? `Release controls and report passed (${options.reportPath}).`
      : "Release gate controls passed (CI, SBOM, licenses, signing, RC evidence, and traceability).",
  );
}

if (isMain()) main();
