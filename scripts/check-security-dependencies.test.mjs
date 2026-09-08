import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const cliRequire = createRequire(
  realpathSync(
    new URL(
      "../apps/desktop/node_modules/@wdio/cli/package.json",
      import.meta.url,
    ),
  ),
);
const utilsManifest = cliRequire.resolve
  .paths("@wdio/utils")
  .map((root) => path.join(root, "@wdio/utils/package.json"))
  .find(existsSync);
assert.ok(utilsManifest, "WebdriverIO utilities must be installed");
const utilsRequire = createRequire(realpathSync(utilsManifest));

describe("security dependency override compatibility", () => {
  it("loads WebdriverIO's actual browser management imports", async () => {
    await assert.doesNotReject(
      import(
        pathToFileURL(
          path.join(path.dirname(realpathSync(utilsManifest)), "build/node.js"),
        )
      ),
    );
  });
  it("resolves an installed browser path with Puppeteer Browsers 3", async () => {
    const { Browser, BrowserPlatform, computeExecutablePath } = await import(
      pathToFileURL(utilsRequire.resolve("@puppeteer/browsers"))
    );
    const cacheDir = path.join(tmpdir(), "bx-ssh-browser-path-test");
    const executable = computeExecutablePath({
      cacheDir,
      browser: Browser.CHROME,
      platform: BrowserPlatform.LINUX,
      buildId: "123.0.0.0",
    });
    assert.ok(executable.startsWith(`${cacheDir}${path.sep}`));
    assert.equal(path.basename(executable), "chrome");
  });
  it("preserves WebdriverIO's nested capability merge behavior", () => {
    const { deepmerge } = utilsRequire("deepmerge-ts");
    assert.deepEqual(
      deepmerge(
        {
          "goog:chromeOptions": {
            args: ["--headless"],
            prefs: { download: { prompt_for_download: true } },
          },
        },
        {
          "goog:chromeOptions": {
            args: ["--disable-gpu"],
            prefs: { download: { default_directory: "downloads" } },
          },
        },
      ),
      {
        "goog:chromeOptions": {
          args: ["--headless", "--disable-gpu"],
          prefs: {
            download: {
              prompt_for_download: true,
              default_directory: "downloads",
            },
          },
        },
      },
    );
  });
  it("terminates Nano ID's zero-length custom generator", () => {
    const viteRequire = createRequire(
      realpathSync(
        new URL(
          "../apps/desktop/node_modules/vite/package.json",
          import.meta.url,
        ),
      ),
    );
    const postcssRequire = createRequire(viteRequire.resolve("postcss"));
    execFileSync(
      process.execPath,
      [
        "-e",
        "const { customAlphabet } = require(process.argv[1]); if (customAlphabet('abc', 0)() !== '') process.exit(1);",
        postcssRequire.resolve("nanoid"),
      ],
      { timeout: 5000, stdio: "pipe" },
    );
  });
});
