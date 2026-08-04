import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const desktopPackage = readJson("apps/desktop/package.json");
const tauriConfig = readJson("apps/desktop/src-tauri/tauri.conf.json");
const defaultCapability = readJson(
  "apps/desktop/src-tauri/capabilities/default.json",
);
const e2eConfig = readJson("apps/desktop/tests/e2e/tauri.e2e.conf.json");
const mainPermission = readText("apps/desktop/src-tauri/permissions/main.toml");
const desktopHtml = readText("apps/desktop/index.html");
const desktopStyles = readText("apps/desktop/src/styles.css");
const preferenceInitializer = readText(
  "apps/desktop/public/ui-preferences-init.js",
);
const violations = [];

const reviewedApplicationCommands = [
  "app_info",
  "probe_ssh_host",
  "start_password_shell",
  "write_terminal",
  "resize_terminal",
  "acknowledge_terminal_output",
  "close_terminal_session",
  "start_password_sftp",
  "list_sftp_directory",
  "upload_sftp_file",
  "download_sftp_file",
  "hash_remote_sftp_file",
  "close_sftp_session",
  "set_webview_memory_usage",
  "check_for_update",
  "install_update",
  "confirm_app_exit",
  "list_connections",
  "get_connection",
  "preview_openssh_config",
  "import_openssh_connections",
];
const productionPermissions = new Set([
  "allow-main-commands",
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "core:window:allow-close",
  "core:window:allow-is-maximized",
  "core:window:allow-minimize",
  "core:window:allow-start-dragging",
  "core:window:allow-toggle-maximize",
  "dialog:allow-open",
]);
const e2ePermissions = new Set([
  "allow-main-commands",
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "core:window:allow-close",
  "core:window:allow-is-maximized",
  "core:window:allow-is-minimized",
  "core:window:allow-minimize",
  "core:window:allow-start-dragging",
  "core:window:allow-toggle-maximize",
  "dialog:allow-open",
  "wdio:default",
  "wdio-webdriver:default",
]);

checkCapability(defaultCapability, "production", productionPermissions);
checkMainPermission(mainPermission, reviewedApplicationCommands);
const e2eCapabilities = e2eConfig.app?.security?.capabilities ?? [];
if (e2eCapabilities.length !== 1) {
  violations.push("E2E configuration must define exactly one capability");
} else {
  checkCapability(e2eCapabilities[0], "E2E", e2ePermissions);
}

checkCsp(tauriConfig.app?.security?.csp, "production", {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "connect-src": ["'self'", "ipc:", "http://ipc.localhost"],
  "font-src": ["'self'"],
  "img-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
});
checkCsp(tauriConfig.app?.security?.devCsp, "development", {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "connect-src": [
    "'self'",
    "ipc:",
    "http://ipc.localhost",
    "ws://localhost:1420",
  ],
  "font-src": ["'self'"],
  "img-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
});
checkUiPreferenceBootstrap(desktopHtml, preferenceInitializer);
checkOfflineFonts([
  ["apps/desktop/index.html", desktopHtml],
  ["apps/desktop/src/styles.css", desktopStyles],
  ["apps/desktop/public/ui-preferences-init.js", preferenceInitializer],
]);

if (tauriConfig.app?.security?.dangerousDisableAssetCspModification === true) {
  violations.push("Tauri asset CSP modification must remain enabled");
}

const updaterEndpoints = tauriConfig.plugins?.updater?.endpoints ?? [];
const expectedUpdaterEndpoint =
  "https://github.com/baoxue2026/bx-ssh/releases/latest/download/latest.json";
if (
  updaterEndpoints.length !== 1 ||
  updaterEndpoints[0] !== expectedUpdaterEndpoint
) {
  violations.push("Updater must use only the reviewed BX SSH GitHub endpoint");
} else {
  const endpoint = new URL(updaterEndpoints[0]);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "github.com" ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    violations.push(
      "Updater endpoint must be credential-free HTTPS on github.com",
    );
  }
}

const bannedTauriPlugins = new Set([
  "tauri-plugin-fs",
  "tauri-plugin-http",
  "tauri-plugin-opener",
  "tauri-plugin-process",
  "tauri-plugin-shell",
]);
const cargoMetadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const desktopCargoPackage = cargoMetadata.packages.find(
  (entry) => entry.name === "bx-ssh-desktop",
);
if (!desktopCargoPackage) {
  violations.push("Cargo metadata does not contain bx-ssh-desktop");
} else {
  for (const dependency of desktopCargoPackage.dependencies) {
    if (bannedTauriPlugins.has(dependency.name)) {
      violations.push(`Forbidden Rust Tauri plugin: ${dependency.name}`);
    }
  }
}

const npmDependencies = {
  ...desktopPackage.dependencies,
  ...desktopPackage.devDependencies,
};
for (const plugin of ["fs", "http", "opener", "process", "shell"]) {
  const dependency = `@tauri-apps/plugin-${plugin}`;
  if (dependency in npmDependencies) {
    violations.push(`Forbidden frontend Tauri plugin: ${dependency}`);
  }
}

if (violations.length > 0) {
  console.error("Tauri security gate failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Tauri security gate passed (capabilities, CSP, updater endpoint, dependencies).",
);

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function checkCapability(capability, label, allowedPermissions) {
  if (capability.local !== true) {
    violations.push(`${label} capability must be explicitly local-only`);
  }
  if ("remote" in capability) {
    violations.push(`${label} capability must not allow remote URLs`);
  }
  if (
    !Array.isArray(capability.windows) ||
    capability.windows.length !== 1 ||
    capability.windows[0] !== "main"
  ) {
    violations.push(`${label} capability must target only the main window`);
  }

  const permissions = capability.permissions ?? [];
  const identifiers = permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  if (
    identifiers.length !== allowedPermissions.size ||
    new Set(identifiers).size !== identifiers.length ||
    identifiers.some((identifier) => !allowedPermissions.has(identifier))
  ) {
    violations.push(
      `${label} capability permissions differ from the reviewed allowlist`,
    );
  }
}

function checkMainPermission(value, expectedCommands) {
  const permissionEntries = value.match(/^\[\[permission\]\]$/gm) ?? [];
  if (permissionEntries.length !== 1) {
    violations.push("Main permission file must define exactly one permission");
  }

  const identifiers = [...value.matchAll(/^identifier\s*=\s*"([^"]+)"$/gm)].map(
    (match) => match[1],
  );
  if (identifiers.length !== 1 || identifiers[0] !== "allow-main-commands") {
    violations.push("Main permission identifier must be allow-main-commands");
  }

  const allowBlocks = [
    ...value.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g),
  ];
  if (allowBlocks.length !== 1) {
    violations.push(
      "Main permission must define exactly one command allowlist",
    );
    return;
  }

  const commands = [...allowBlocks[0][1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (
    commands.length !== expectedCommands.length ||
    new Set(commands).size !== commands.length ||
    commands.some((command, index) => command !== expectedCommands[index])
  ) {
    violations.push(
      "Main command allowlist differs from the reviewed commands",
    );
  }

  if (/commands\.deny\s*=/.test(value)) {
    violations.push("Main permission must not contain a separate deny list");
  }
}

function checkCsp(value, label, expectedDirectives) {
  if (typeof value !== "string") {
    violations.push(`${label} CSP must be a string`);
    return;
  }

  const directives = new Map();
  for (const segment of value.split(";")) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    if (directives.has(name)) {
      violations.push(`${label} CSP repeats ${name}`);
    }
    directives.set(name, sources);
  }

  if (directives.size !== Object.keys(expectedDirectives).length) {
    violations.push(`${label} CSP contains an unreviewed or missing directive`);
  }
  for (const [name, expectedSources] of Object.entries(expectedDirectives)) {
    const actualSources = directives.get(name) ?? [];
    if (
      actualSources.length !== expectedSources.length ||
      actualSources.some((source) => !expectedSources.includes(source))
    ) {
      violations.push(`${label} CSP ${name} differs from the reviewed sources`);
    }
  }

  for (const [name, sources] of directives) {
    for (const source of sources) {
      if (source === "*" || source === "'unsafe-eval'") {
        violations.push(`${label} CSP ${name} contains ${source}`);
      }
      if (source === "'unsafe-inline'" && name !== "style-src") {
        violations.push(`${label} CSP allows inline content in ${name}`);
      }
    }
  }
}

function checkUiPreferenceBootstrap(html, initializer) {
  const initializerTag = '<script src="/ui-preferences-init.js"></script>';
  const applicationTag = '<script type="module" src="/src/main.tsx"></script>';
  const initializerIndex = html.indexOf(initializerTag);
  const applicationIndex = html.indexOf(applicationTag);

  if (
    initializerIndex < 0 ||
    applicationIndex < 0 ||
    initializerIndex > applicationIndex
  ) {
    violations.push(
      "UI preference bootstrap must load synchronously before the React entry point",
    );
  }

  for (const requiredValue of [
    "bx-ssh.theme-mode",
    "bx-ssh.language",
    "prefers-color-scheme: dark",
    "dataset.theme",
    "dataset.themeMode",
  ]) {
    if (!initializer.includes(requiredValue)) {
      violations.push(
        `UI preference bootstrap does not initialize ${requiredValue}`,
      );
    }
  }
}

function checkOfflineFonts(files) {
  const remoteFontPatterns = [
    /fonts\.googleapis\.com/i,
    /fonts\.gstatic\.com/i,
    /@import\s+(?:url\()?\s*["']?https?:\/\//i,
    /url\(\s*["']?https?:\/\//i,
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']https?:\/\//i,
  ];

  for (const [path, source] of files) {
    if (remoteFontPatterns.some((pattern) => pattern.test(source))) {
      violations.push(`${path} must not load remote font resources`);
    }
  }
}
