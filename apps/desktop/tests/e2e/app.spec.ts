import { execFile } from "node:child_process";
import path from "node:path";
import { browser, expect, $ } from "@wdio/globals";
import { prepareApplication } from "./application";
import { e2eProfile } from "./profile";

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
  before(async () => {
    await prepareApplication({ clearSshFixtures: true });
  });

  it("loads the application and invokes the Rust backend", async () => {
    const shell = await $(".app-shell");
    await shell.waitForDisplayed();

    const appInfo = (await browser.tauri.execute(({ core }) =>
      core.invoke("app_info"),
    )) as AppInfo;

    await expect($(".brand")).toHaveText(appInfo.name);
    await expect($(".version")).toHaveText(`v${appInfo.version}`);
    await expect($(".sidebar")).toHaveAttribute("aria-label", "SSH 连接验证");
    await expect($(".connection-workspace-empty")).toBeDisplayed();
    await expect($(".connection-workspace-empty")).toHaveAttribute(
      "aria-label",
      "开始使用 BX SSH",
    );
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

  it("completes core navigation with the keyboard", async () => {
    await browser.keys(["Control", "n"]);
    const connectionDialog = await $('[role="dialog"]');
    await connectionDialog.waitForDisplayed();
    await expect($(".ant-modal-title=新建连接")).toBeDisplayed();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return dialog?.contains(document.activeElement) ?? false;
        }),
      { timeoutMsg: "the connection dialog did not receive keyboard focus" },
    );

    await browser.keys(["Escape"]);
    await connectionDialog.waitForDisplayed({ reverse: true });

    await browser.keys(["Control", "b"]);
    await browser.waitUntil(async () =>
      ((await $(".sidebar").getAttribute("class")) ?? "").includes(
        "is-collapsed",
      ),
    );
    await browser.keys(["Control", "b"]);
    await browser.waitUntil(
      async () =>
        !((await $(".sidebar").getAttribute("class")) ?? "").includes(
          "is-collapsed",
        ),
    );

    await focusAndActivate('button[aria-label="设置"]');
    await expect($(".settings-view")).toBeDisplayed();
    await focusAndActivate(".settings-nav-item:nth-child(2)");
    await expect($(".settings-content h2")).toHaveText("终端");
    await focusAndActivate(".settings-header button");
    await $(".settings-view").waitForDisplayed({ reverse: true });

    await browser.keys(["Control", "1"]);
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

  it("keeps key workflow regions inside the configured viewport", async () => {
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
        documentWidth: document.documentElement.scrollWidth,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        topbarHeight: topbar.height,
        controls,
        regions: [".topbar", ".workspace", ".statusbar"].map((selector) => {
          const rect = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return {
            selector,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            top: rect.top,
          };
        }),
      };
    })) as {
      devicePixelRatio: number;
      documentWidth: number;
      innerHeight: number;
      innerWidth: number;
      topbarHeight: number;
      controls: Array<{ left: number; right: number; width: number }>;
      regions: Array<{
        selector: string;
        bottom: number;
        left: number;
        right: number;
        top: number;
      }>;
    };

    if (e2eProfile.expectedDeviceScaleFactor !== null) {
      expect(
        Math.abs(
          geometry.devicePixelRatio - e2eProfile.expectedDeviceScaleFactor,
        ),
      ).toBeLessThanOrEqual(0.05);
    } else {
      expect(geometry.devicePixelRatio).toBeGreaterThan(0);
    }
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.innerWidth + 1);
    expect(geometry.topbarHeight).toBe(38);
    expect(geometry.controls).toHaveLength(3);
    for (const control of geometry.controls) {
      expect(control.width).toBe(46);
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(geometry.innerWidth);
    }
    for (const region of geometry.regions) {
      expect(region.left).toBeGreaterThanOrEqual(-1);
      expect(region.top).toBeGreaterThanOrEqual(-1);
      expect(region.right).toBeLessThanOrEqual(geometry.innerWidth + 1);
      expect(region.bottom).toBeLessThanOrEqual(geometry.innerHeight + 1);
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
    await expect($(".sidebar")).toHaveAttribute(
      "aria-label",
      "SSH connection verification",
    );
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
    await expect($(".sidebar")).toHaveAttribute("aria-label", "SSH 连接验证");
  });

  it("restores the existing window when a second instance starts", async () => {
    await $(".window-control:first-child").click();
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
  const triggerLabel = menuLabel === "Appearance" ? "Theme" : "主题";
  await $(`button[aria-label="${triggerLabel}"]`).click();
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

async function focusAndActivate(selector: string): Promise<void> {
  const target = await $(selector);
  const focused = await browser.execute((targetSelector) => {
    const element = document.querySelector<HTMLElement>(targetSelector);
    element?.focus();
    return document.activeElement === element;
  }, selector);
  expect(focused).toBe(true);
  await target.click();
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
