import path from "node:path";
import type { TauriCapabilities } from "@wdio/tauri-service";

const executable =
  process.platform === "win32" ? "bx-ssh-desktop.exe" : "bx-ssh-desktop";
const application = process.env.BX_SSH_E2E_BINARY
  ? path.resolve(process.env.BX_SSH_E2E_BINARY)
  : path.resolve("../../target/debug", executable);
const reportDirectory = path.resolve("../../artifacts/test-reports/e2e");
const logDirectory = path.join(reportDirectory, "logs");
const tauriCapability = {
  browserName: "tauri",
  "tauri:options": {
    application,
  },
} satisfies TauriCapabilities;

export const config: WebdriverIO.Config = {
  runner: "local",
  outputDir: logDirectory,
  specs: ["./tests/e2e/**/*.spec.ts"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: application,
        driverProvider: "embedded",
        embeddedPort: 4445,
        startTimeout: 90_000,
        statusPollTimeout: 5_000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        logDir: logDirectory,
      },
    ],
  ],
  capabilities: [tauriCapability],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
  reporters: [
    "spec",
    [
      "junit",
      {
        outputDir: reportDirectory,
        outputFileFormat: () => `e2e-${process.platform}.xml`,
      },
    ],
  ],
};
