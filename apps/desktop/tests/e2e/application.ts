import { browser, $ } from "@wdio/globals";
import { e2eProfile } from "./profile";
import type { ConnectionCatalog } from "../../src/ipc/bindings";

export async function prepareApplication({
  clearSshFixtures = false,
} = {}): Promise<void> {
  await $(".app-shell").waitForDisplayed();
  if (clearSshFixtures) {
    const catalog = (await browser.tauri.execute(({ core }) =>
      core.invoke("list_connections"),
    )) as ConnectionCatalog;
    const fixtures = catalog.connections.filter(({ config }) =>
      /^E2E [0-9a-f-]{36}$/.test(config.name),
    );
    for (const { config } of fixtures) {
      await browser.tauri.execute(
        ({ core }, id) => core.invoke("delete_connection", { id }),
        config.id,
      );
    }
    if (fixtures.length > 0) {
      await browser.refresh();
      await $(".app-shell").waitForDisplayed();
    }
  }
  const preferencesChanged = await browser.execute(() => {
    const preferences = {
      "bx-ssh.language": "zh-CN",
      "bx-ssh.theme-mode": "light",
    };
    let changed = false;
    for (const [key, value] of Object.entries(preferences)) {
      if (window.localStorage.getItem(key) !== value) {
        window.localStorage.setItem(key, value);
        changed = true;
      }
    }
    return changed;
  });

  if (preferencesChanged) {
    await browser.refresh();
    await $(".app-shell").waitForDisplayed();
  }

  await browser.setWindowSize(
    e2eProfile.viewportWidth,
    e2eProfile.viewportHeight,
  );
}
