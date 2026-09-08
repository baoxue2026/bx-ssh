import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scaleFactor = parseScaleFactor(
  process.env.BX_SSH_E2E_EXPECTED_DEVICE_SCALE_FACTOR,
);
const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), "bx-ssh-e2e-config-"),
);
const runtimeConfigPath = path.join(temporaryDirectory, "tauri.e2e.conf.json");

try {
  const e2eConfig = readJson(
    path.join(packageDirectory, "tests/e2e/tauri.e2e.conf.json"),
  );

  if (scaleFactor !== null) {
    const applicationConfig = readJson(
      path.join(packageDirectory, "src-tauri/tauri.conf.json"),
    );
    const windows = applicationConfig.app?.windows;

    if (!Array.isArray(windows) || windows.length === 0) {
      throw new Error("Tauri configuration must define at least one window");
    }

    e2eConfig.app = {
      ...e2eConfig.app,
      windows: windows.map((window) => ({
        ...window,
        additionalBrowserArgs: [
          "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
          `--force-device-scale-factor=${scaleFactor}`,
        ].join(" "),
      })),
    };
  }

  writeFileSync(runtimeConfigPath, `${JSON.stringify(e2eConfig, null, 2)}\n`);

  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("build:e2e must be run through pnpm");
  }

  const result = spawnSync(
    process.execPath,
    [
      pnpmCli,
      "exec",
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
      "--features",
      "e2e",
      "--config",
      runtimeConfigPath,
    ],
    {
      cwd: packageDirectory,
      env: { ...process.env, VITE_E2E: "true" },
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

function parseScaleFactor(value) {
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `BX_SSH_E2E_EXPECTED_DEVICE_SCALE_FACTOR must be a positive number, received: ${value}`,
    );
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
