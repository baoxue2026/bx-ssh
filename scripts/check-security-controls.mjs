import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const reviewedPaths = [
  "crates/contracts/src/connection.rs",
  "crates/contracts/src/sensitive.rs",
  "crates/persistence/src/credential.rs",
  "crates/persistence/src/private_key.rs",
  "crates/ssh-core/src/fingerprint.rs",
  "crates/ssh-core/src/session.rs",
  "crates/ssh-core/src/sftp.rs",
  "apps/desktop/src-tauri/src/command_error.rs",
  "apps/desktop/src-tauri/src/diagnostics.rs",
  "apps/desktop/src-tauri/src/external_links.rs",
  "apps/desktop/src-tauri/src/local_files.rs",
  "apps/desktop/src-tauri/src/logging.rs",
  "apps/desktop/src-tauri/permissions/main.toml",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src/components/terminalSecurity.ts",
  "apps/desktop/src/components/terminalSecurity.test.ts",
  "apps/desktop/src/components/hostValidation.test.ts",
];

export function loadReviewedFiles(root = workspace) {
  return Object.fromEntries(
    reviewedPaths.map((relativePath) => [
      relativePath,
      readFileSync(path.join(root, relativePath), "utf8"),
    ]),
  );
}

export function validateSecurityControls(files) {
  const violations = [];
  const source = (relativePath) => files[relativePath] ?? "";
  const requireText = (relativePath, pattern, description) => {
    if (!pattern.test(source(relativePath))) {
      violations.push(`${relativePath} is missing ${description}`);
    }
  };

  const contracts = source("crates/contracts/src/connection.rs");
  if (
    /\bpub\s+(?:password|private_key|private_key_contents|secret)\s*:/i.test(
      contracts,
    )
  ) {
    violations.push(
      "connection contracts must expose references, never credential or private-key material",
    );
  }

  requireText(
    "crates/contracts/src/sensitive.rs",
    /#\[serde\(transparent\)\]/,
    "a transparent IPC representation for sensitive values",
  );
  requireText(
    "crates/contracts/src/sensitive.rs",
    /impl\s+fmt::Debug\s+for\s+SensitiveString[\s\S]*?\[REDACTED\]/,
    "redacted Debug output for sensitive values",
  );
  requireText(
    "crates/contracts/src/sensitive.rs",
    /impl\s+Drop\s+for\s+SensitiveString[\s\S]*?zeroize\(\)/,
    "zeroization when sensitive values are dropped",
  );

  const credentialStore = source("crates/persistence/src/credential.rs");
  for (const [pattern, description] of [
    [/struct\s+SystemCredentialStore/, "an operating-system credential store"],
    [/trait\s+SecretCredentialStore/, "a secret credential-store abstraction"],
    [/get_password\(\)/, "credential-store password reads"],
    [/set_password\(/, "credential-store password writes"],
    [/get_secret\(\)/, "credential-store data-key reads"],
    [/set_secret\(/, "credential-store data-key writes"],
    [/clear_secret_from_error/, "secret clearing from credential errors"],
  ]) {
    if (!pattern.test(credentialStore)) {
      violations.push(`credential store is missing ${description}`);
    }
  }

  const privateKey = source("crates/persistence/src/private_key.rs");
  for (const [pattern, description] of [
    [/Aes256Gcm/, "authenticated encryption for imported keys"],
    [/const\s+AAD:/, "domain-separated authenticated data"],
    [/MAX_PRIVATE_KEY_LEN/, "a private-key size bound"],
    [/ciphertext.*\[REDACTED\]/, "redacted private-key Debug output"],
  ]) {
    if (!pattern.test(privateKey)) {
      violations.push(`private-key envelope is missing ${description}`);
    }
  }

  const fingerprint = source("crates/ssh-core/src/fingerprint.rs");
  for (const [pattern, description] of [
    [/SHA256_PREFIX\s*:\s*&str\s*=\s*"SHA256:"/, "the OpenSSH SHA-256 prefix"],
    [
      /SHA256_BASE64_LENGTH\s*:\s*usize\s*=\s*43/,
      "the unpadded SHA-256 length",
    ],
    [
      /is_ascii_alphanumeric\(\)\s*\|\|\s*matches!\(byte, b'\+' \| b'\/'\)/,
      "strict base64 character validation",
    ],
  ]) {
    if (!pattern.test(fingerprint)) {
      violations.push(`host fingerprint validation is missing ${description}`);
    }
  }
  requireText(
    "crates/ssh-core/src/session.rs",
    /HostFingerprint::parse\(expected_fingerprint\)/,
    "required fingerprint parsing before authentication",
  );
  requireText(
    "crates/ssh-core/src/session.rs",
    /HostKeyMismatch\s*\{/,
    "changed-host rejection",
  );

  const remotePaths = source("crates/ssh-core/src/sftp.rs");
  for (const [pattern, description] of [
    [/fn\s+validate_remote_path/, "remote path validation"],
    [/component\s*==\s*"\.\."/, "parent-directory rejection"],
    [/path\.contains\('\\\\'\)/, "backslash rejection"],
    [/reject_remote_symlink_components/, "remote symlink-component rejection"],
    [/OpenFlags::EXCLUDE/, "exclusive temporary remote writes"],
  ]) {
    if (!pattern.test(remotePaths)) {
      violations.push(`remote SFTP safety is missing ${description}`);
    }
  }

  const localPaths = source("apps/desktop/src-tauri/src/local_files.rs");
  for (const [pattern, description] of [
    [/fn\s+validate_local_path/, "local path validation"],
    [/contains\('\\0'\)/, "NUL-byte rejection"],
    [/reject_symlink_components/, "local symlink-component rejection"],
    [/fs::canonicalize/, "canonical directory resolution"],
  ]) {
    if (!pattern.test(localPaths)) {
      violations.push(`local path safety is missing ${description}`);
    }
  }

  const externalLinks = source("apps/desktop/src-tauri/src/external_links.rs");
  for (const [pattern, description] of [
    [/fn\s+validate_external_url/, "external URL validation"],
    [
      /matches!\(url\.scheme\(\), "http" \| "https"\)/,
      "HTTP/HTTPS-only schemes",
    ],
    [/!url\.username\(\)\.is_empty\(\)/, "username rejection"],
    [/url\.password\(\)\.is_some\(\)/, "password rejection"],
  ]) {
    if (!pattern.test(externalLinks)) {
      violations.push(`external-link safety is missing ${description}`);
    }
  }

  const logging = source("apps/desktop/src-tauri/src/logging.rs");
  const runtimeLogging = logging.split("#[cfg(test)]", 1)[0];
  for (const [pattern, description] of [
    [/struct\s+LogFields/, "a structured log field type"],
    [
      /Only stable identifiers and enums are accepted/,
      "the no-free-form-log-field boundary",
    ],
    [/struct\s+LogEntry/, "a structured log entry"],
    [/pub\(crate\) fn connection_error/, "sanitized connection-error logging"],
  ]) {
    if (!pattern.test(logging)) {
      violations.push(`runtime logging is missing ${description}`);
    }
  }
  if (
    /(?:password|private[_-]?key|terminal[_-]?input|authentication[_-]?answer)/i.test(
      runtimeLogging,
    )
  ) {
    violations.push(
      "runtime logging source must not contain sensitive field names",
    );
  }

  const diagnostics = source("apps/desktop/src-tauri/src/diagnostics.rs");
  for (const [pattern, description] of [
    [/fn\s+allowlisted_log_entry/, "an allowlisted diagnostic log projection"],
    [/fn\s+sanitize_log_file/, "line-by-line diagnostic sanitization"],
    [/const\s+ALLOWED_FIELDS/, "an explicit diagnostic field allowlist"],
    [/MAX_LOG_LINE_BYTES/, "a diagnostic log line size bound"],
  ]) {
    if (!pattern.test(diagnostics)) {
      violations.push(`diagnostic export is missing ${description}`);
    }
  }

  const permission = source("apps/desktop/src-tauri/permissions/main.toml");
  if (/commands\.allow\s*=\s*\[\s*"\*"/.test(permission)) {
    violations.push("Tauri main command permissions must not use a wildcard");
  }
  if (/allow-(?:shell|process|fs|http|opener)/i.test(permission)) {
    violations.push(
      "Tauri main permissions must not expose shell, process, filesystem, HTTP, or opener APIs",
    );
  }
  requireText(
    "apps/desktop/src-tauri/permissions/main.toml",
    /identifier\s*=\s*"allow-main-commands"/,
    "the reviewed main command permission identifier",
  );

  const tauriConfig = JSON.parse(
    source("apps/desktop/src-tauri/tauri.conf.json") || "{}",
  );
  const productionCsp = tauriConfig.app?.security?.csp;
  if (
    typeof productionCsp !== "string" ||
    !productionCsp.includes("default-src 'none'") ||
    productionCsp.includes("*") ||
    productionCsp.includes("'unsafe-eval'")
  ) {
    violations.push(
      "production CSP must deny by default and forbid wildcard/eval sources",
    );
  }

  requireText(
    "apps/desktop/src/components/terminalSecurity.ts",
    /parseExternalHttpLink/,
    "frontend external-link validation",
  );
  requireText(
    "apps/desktop/src/components/terminalSecurity.test.ts",
    /javascript:alert\(1\)/,
    "a dangerous external-link regression case",
  );
  requireText(
    "apps/desktop/src/components/hostValidation.test.ts",
    /https:\/\/example\.com/,
    "a host-injection regression case",
  );

  return violations;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const violations = validateSecurityControls(loadReviewedFiles());
  if (violations.length > 0) {
    console.error("Security control check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log(
    "Security control check passed (credentials, fingerprints, paths, logs, CSP, and command boundary).",
  );
}
