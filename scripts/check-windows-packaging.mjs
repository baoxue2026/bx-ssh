import { readFileSync } from "node:fs";

const config = readJson("apps/desktop/src-tauri/tauri.conf.json");
const violations = [];
const windows = config.bundle?.windows;
const nsis = windows?.nsis;
const wix = windows?.wix;
const updaterWindows = config.plugins?.updater?.windows;

if (windows?.allowDowngrades !== false) {
  violations.push("Windows installers must reject downgrades");
}

if (nsis?.installMode !== "currentUser") {
  violations.push("NSIS must use the current-user install mode");
}

if (
  !Array.isArray(nsis?.languages) ||
  !nsis.languages.includes("English") ||
  !nsis.languages.includes("SimpChinese")
) {
  violations.push(
    "NSIS must provide English and Simplified Chinese installer languages",
  );
}

if (nsis?.startMenuFolder !== "BX SSH") {
  violations.push(
    "NSIS shortcuts must be grouped under the BX SSH Start Menu folder",
  );
}

if (wix?.upgradeCode !== "701bc81a-2856-5f89-97c6-ee8383d0e686") {
  violations.push("WiX upgradeCode must remain stable across releases");
}

if (updaterWindows?.installMode !== "passive") {
  violations.push(
    "Windows updater installs must remain passive and restart-aware",
  );
}

if (config.identifier !== "io.github.baoxue2026.bx-ssh") {
  violations.push(
    "The application identifier must remain stable for data and single-instance state",
  );
}

if (violations.length > 0) {
  console.error("Windows packaging policy failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Windows packaging policy passed (current-user install, stable upgrade, downgrade protection, and updater mode).",
);

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );
}
