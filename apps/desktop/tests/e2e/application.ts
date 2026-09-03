import { browser, $ } from "@wdio/globals";
import { e2eProfile } from "./profile";

export async function prepareApplication(): Promise<void> {
  await $(".app-shell").waitForDisplayed();
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
