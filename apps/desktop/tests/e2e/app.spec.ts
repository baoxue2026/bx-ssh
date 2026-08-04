import { execFile } from "node:child_process";
import path from "node:path";
import { browser, expect, $ } from "@wdio/globals";

const executable =
  process.platform === "win32" ? "bx-ssh-desktop.exe" : "bx-ssh-desktop";
const application = process.env.BX_SSH_E2E_BINARY
  ? path.resolve(process.env.BX_SSH_E2E_BINARY)
  : path.resolve("../../target/debug", executable);

interface AppInfo {
  name: string;
  version: string;
}

describe("BX SSH desktop shell", () => {
  it("loads the application and invokes the Rust backend", async () => {
    const shell = await $(".app-shell");
    await shell.waitForDisplayed();

    const appInfo = (await browser.tauri.execute(({ core }) =>
      core.invoke("app_info"),
    )) as AppInfo;

    await expect($(".brand")).toHaveText(appInfo.name);
    await expect($(".version")).toHaveText(`v${appInfo.version}`);
    await expect($("h1=连接验证")).toBeDisplayed();
    await expect($(".terminal-empty")).toHaveAttribute("role", "status");
    await expect($(".terminal-empty")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps form state consistent while switching workspace modes", async () => {
    const host = await $('input[placeholder="hostname 或 IP"]');
    await host.setValue("ssh.example.test");

    await $(".ant-segmented-item=SFTP").click();

    await expect($(".sidebar-heading span")).toHaveText("SFTP v3");
    await expect(host).toHaveValue("ssh.example.test");
    await expect($(".sftp-empty")).toHaveAttribute("role", "status");
    await expect($(".sftp-empty")).toHaveAttribute("aria-live", "polite");
  });

  it("handles the fixed workspace shortcuts", async () => {
    await browser.keys(["Control", "1"]);
    await expect($(".sidebar-heading span")).toHaveText("SSH / PTY");

    await browser.keys(["Control", "2"]);
    await expect($(".sidebar-heading span")).toHaveText("SFTP v3");
  });

  it("maximizes and restores from the custom title bar", async () => {
    const maximize = await $('button[aria-label="最大化窗口"]');
    await maximize.click();
    await browser.waitUntil(
      () =>
        browser.tauri.execute(({ core }) =>
          core
            .invoke("plugin:window|is_maximized", { label: "main" })
            .then((value) => value as boolean),
        ),
      { timeoutMsg: "the BX SSH window did not maximize" },
    );

    const restore = await $('button[aria-label="还原窗口"]');
    await restore.click();
    await browser.waitUntil(
      async () =>
        !(await browser.tauri.execute(({ core }) =>
          core
            .invoke("plugin:window|is_maximized", { label: "main" })
            .then((value) => value as boolean),
        )),
      { timeoutMsg: "the BX SSH window did not restore" },
    );
  });

  it("keeps title-bar controls inside the viewport at Windows scale", async () => {
    const geometry = (await browser.execute(() => {
      const topbar = document.querySelector(".topbar")!.getBoundingClientRect();
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(".window-control"),
      ).map((control) => {
        const rect = control.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      });
      return {
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        topbarHeight: topbar.height,
        controls,
      };
    })) as {
      devicePixelRatio: number;
      innerWidth: number;
      topbarHeight: number;
      controls: Array<{ left: number; right: number; width: number }>;
    };

    expect(geometry.devicePixelRatio).toBeGreaterThanOrEqual(1);
    expect(geometry.topbarHeight).toBe(42);
    expect(geometry.controls).toHaveLength(3);
    for (const control of geometry.controls) {
      expect(control.width).toBe(46);
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(geometry.innerWidth);
    }
  });

  it("switches language and theme while keeping startup preferences initialized", async () => {
    const startupPreferences = (await browser.execute(() => ({
      language: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      themeMode: document.documentElement.dataset.themeMode,
      remoteFontRequests: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /fonts\.(?:googleapis|gstatic)\.com/i.test(name)),
    }))) as {
      language: string;
      remoteFontRequests: string[];
      theme?: string;
      themeMode?: string;
    };

    expect(["light", "dark"]).toContain(startupPreferences.theme);
    expect(["light", "dark", "system"]).toContain(startupPreferences.themeMode);
    expect(["zh-CN", "en-US"]).toContain(startupPreferences.language);
    expect(startupPreferences.remoteFontRequests).toEqual([]);

    await selectAppearanceItem("外观", "English");
    await expect($("h1=Connection Verification")).toBeDisplayed();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.lang)) ===
        "en-US",
    );

    await selectAppearanceItem("Appearance", "Dark");
    await expectRootPreferences("dark", "dark");

    await selectAppearanceItem("Appearance", "Light");
    await expectRootPreferences("light", "light");

    await selectAppearanceItem("Appearance", "Use System Setting");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.documentElement.dataset.themeMode,
        )) === "system",
    );

    await selectAppearanceItem("Appearance", "Simplified Chinese");
    await expect($("h1=连接验证")).toBeDisplayed();
  });

  it("restores the existing window when a second instance starts", async () => {
    await $('button[aria-label="最小化窗口"]').click();
    await browser.waitUntil(
      () =>
        browser.tauri.execute(({ core }) =>
          core
            .invoke("plugin:window|is_minimized", { label: "main" })
            .then((value) => value as boolean),
        ),
      { timeoutMsg: "the custom title bar did not minimize the window" },
    );

    await launchSecondaryInstance();

    await browser.waitUntil(
      async () =>
        !(await browser.tauri.execute(({ core }) =>
          core
            .invoke("plugin:window|is_minimized", { label: "main" })
            .then((value) => value as boolean),
        )),
      {
        timeout: 10_000,
        timeoutMsg: "the existing BX SSH window remained minimized",
      },
    );
    await expect($(".app-shell")).toBeDisplayed();
  });
});

async function selectAppearanceItem(menuLabel: string, itemLabel: string) {
  await $(`button=${menuLabel}`).click();
  const item = await $(`.ant-dropdown-menu-item=${itemLabel}`);
  await item.waitForDisplayed();
  await item.click();
}

async function expectRootPreferences(theme: string, themeMode: string) {
  await browser.waitUntil(async () => {
    const preferences = (await browser.execute(() => ({
      theme: document.documentElement.dataset.theme,
      themeMode: document.documentElement.dataset.themeMode,
    }))) as { theme?: string; themeMode?: string };
    return preferences.theme === theme && preferences.themeMode === themeMode;
  });
}

async function launchSecondaryInstance(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(application, { timeout: 10_000, windowsHide: true }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
