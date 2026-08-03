import { browser, expect, $ } from "@wdio/globals";

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
});
