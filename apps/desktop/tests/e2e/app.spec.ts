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
  });

  it("keeps form state consistent while switching workspace modes", async () => {
    const host = await $('input[placeholder="hostname 或 IP"]');
    await host.setValue("ssh.example.test");

    await $(".ant-segmented-item=SFTP").click();

    await expect($(".sidebar-heading span")).toHaveText("SFTP v3");
    await expect(host).toHaveValue("ssh.example.test");
  });

  it("restores the existing window when a second instance starts", async () => {
    const minimized = await browser.tauri.execute(async ({ core }) => {
      await core.invoke("plugin:window|minimize", { label: "main" });
      return (await core.invoke("plugin:window|is_minimized", {
        label: "main",
      })) as boolean;
    });
    expect(minimized).toBe(true);

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
