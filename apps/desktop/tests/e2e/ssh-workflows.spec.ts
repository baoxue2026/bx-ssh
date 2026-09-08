import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { browser, expect, $ } from "@wdio/globals";
import type { ConnectionCatalog } from "../../src/ipc/bindings";
import { prepareApplication } from "./application";

// The Windows fixture runner owns the temporary server, account and credentials.
const withServer = process.env.BX_SSH_TEST_DESKTOP_E2E === "1";
const describeSsh = withServer ? describe : describe.skip;
const connectionName = `E2E ${randomUUID()}`;
let localRoot = "";
let sourcePath = "";
let remoteRoot = "";
let host: string;
let port: string;
let username: string;
let password: string;
let fingerprint: string;
let sourceHash: string;

describeSsh("BX SSH real OpenSSH workflows", () => {
  before(async () => {
    host = requiredEnvironment("BX_SSH_TEST_HOST");
    port = requiredEnvironment("BX_SSH_TEST_PORT");
    username = requiredEnvironment("BX_SSH_TEST_USERNAME");
    password = requiredEnvironment("BX_SSH_TEST_PASSWORD");
    fingerprint = requiredEnvironment("BX_SSH_TEST_EXPECTED_FINGERPRINT");
    localRoot = await mkdtemp(path.join(tmpdir(), "bx-ssh-e2e-transfer-"));
    sourcePath = path.join(localRoot, "source.bin");
    const contents = randomBytes(512 * 1024);
    sourceHash = sha256(contents);
    await writeFile(sourcePath, contents);
    await prepareApplication({ clearSshFixtures: true });
  });

  after(async () => {
    try {
      await disconnectIfConnected();
      const catalog = (await browser.tauri.execute(({ core }) =>
        core.invoke("list_connections"),
      )) as ConnectionCatalog;
      for (const connection of catalog.connections) {
        if (connection.config.name === connectionName) {
          await browser.tauri.execute(
            ({ core }, id) => core.invoke("delete_connection", { id }),
            connection.config.id,
          );
        }
      }
    } finally {
      if (localRoot) await rm(localRoot, { recursive: true, force: true });
    }
  });

  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const report = path.resolve("../../artifacts/test-reports/e2e");
    const name = `ssh-failure-${Date.now()}`;
    const state = await browser.execute(() => ({
      terminal: document.querySelector(".xterm-rows")?.textContent,
      activeElement: document.activeElement?.className,
      errors: Array.from(document.querySelectorAll(".ant-alert-error")).map(
        (item) => item.textContent,
      ),
      dialogs: Array.from(document.querySelectorAll(".ant-modal-title")).map(
        (item) => item.textContent,
      ),
    }));
    if (state.terminal) {
      state.terminal = state.terminal
        .replaceAll(username, "<test-user>")
        .replaceAll(password, "<redacted>")
        .replace(/@[^\s]+/g, "@<test-host>")
        .replace(/[A-Z]:\\Users\\[^>]+>/g, "<test-home>>");
    }
    await writeFile(
      path.join(report, `${name}.json`),
      JSON.stringify(state, null, 2),
    );
  });

  it("saves a connection, verifies the host, rejects a bad password and executes a real shell command", async () => {
    await browser.keys(["Control", "n"]);
    await $("#connection-name").setValue(connectionName);
    await $("#connection-host").setValue(host);
    await $("#connection-port").setValue(port);
    await $("#connection-username").setValue(username);
    await $('button[aria-label="保存并连接"]').click();

    await expect($(".host-fingerprint-value code")).toHaveText(fingerprint);
    await $("button=信任并继续").click();
    const passwordInput = $(
      '.connection-launch-dialog input[autocomplete="current-password"]',
    );
    await passwordInput.setValue(`${password}-incorrect`);
    await button("连接", ".connection-launch-dialog").click();
    await expect(
      $(".connection-launch-dialog .ant-alert-error"),
    ).toBeDisplayed();
    await passwordInput.setValue(password);
    await button("连接", ".connection-launch-dialog").click();
    await expect(button("断开", ".connection-form")).toBeDisplayed();

    const marker = randomUUID().replaceAll("-", "");
    const windows = process.env.BX_SSH_TEST_SHELL_KIND === "windows-cmd";
    const command = windows
      ? `echo BX_E2E_%OS%_${marker}`
      : `printf 'BX_E2E_%s_%s\\n' 'POSIX' '${marker}'`;
    const expectedOutput = `BX_E2E_${windows ? "Windows_NT" : "POSIX"}_${marker}`;
    await $(".terminal-surface").click();
    await browser.execute(() =>
      document
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus(),
    );
    // The embedded driver dispatches both keydown and insertText for printable
    // keys, which xterm receives twice. Send one text-input event through xterm's
    // normal input handler; keep Enter as a real WebDriver keyboard action.
    await browser.execute((text) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      )!;
      textarea.value = text;
      textarea.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }),
      );
    }, command);
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await $(".xterm-rows").getText()).includes(expectedOutput),
      { timeoutMsg: "the terminal did not render the remote command result" },
    );
    await disconnectIfConnected();

    await browser.refresh();
    await prepareApplication();
    const catalog = (await browser.tauri.execute(({ core }) =>
      core.invoke("list_connections"),
    )) as ConnectionCatalog;
    const saved = catalog.connections.find(
      (entry) => entry.config.name === connectionName,
    );
    expect(saved?.config.host).toBe(host);
    expect(saved?.config.port).toBe(Number(port));
    expect(JSON.stringify(catalog)).not.toContain(password);
  });

  it("uploads and downloads verified bytes and explicitly resolves a file conflict", async () => {
    await disconnectIfConnected();
    await browser.refresh();
    await prepareApplication();
    await $(".ant-segmented-item=SFTP").click();
    await $('.connection-form input[placeholder="hostname 或 IP"]').setValue(
      host,
    );
    await $(".connection-form .ant-input-number-input").setValue(port);
    await button("检测主机指纹", ".connection-form").click();
    await expect($(".fingerprint-panel code")).toHaveText(fingerprint);
    const trust = $(".fingerprint-panel input[type=checkbox]");
    if (!(await trust.isSelected())) await trust.click();
    await $('.connection-form input[autocomplete="username"]').setValue(
      username,
    );
    await $('.connection-form input[autocomplete="current-password"]').setValue(
      password,
    );
    await button("连接", ".connection-form").click();
    await expect(button("断开", ".connection-form")).toBeDisplayed();
    await expect($('input[aria-label="远端路径"]')).toBeEnabled();

    const directoryName = `bx-ssh-e2e-${randomUUID()}`;
    const home = await $('input[aria-label="远端路径"]').getValue();
    remoteRoot = `${home.replace(/\/$/, "")}/${directoryName}`;
    await $('button[aria-label="新建目录"]').click();
    await $('input[aria-label="新目录名称"]').setValue(directoryName);
    await button("确定", '[role="dialog"]').click();
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });

    const remoteFile = `${remoteRoot}/source.bin`;
    await fillTransfer("upload", sourcePath, remoteFile);
    await button("上传", ".sftp-transfer-panel").click();
    await expect($(".sftp-transfer-result code")).toHaveText(sourceHash);

    // Reusing the target must ask before it replaces any bytes.
    await button("上传", ".sftp-transfer-panel").click();
    await expect($(".sftp-conflict-content")).toBeDisplayed();
    await button("跳过", '[role="dialog"]').click();
    await expect($(".sftp-transfer-notice")).toHaveText(
      expect.stringContaining("已跳过"),
    );

    const downloaded = path.join(localRoot, "download.bin");
    await fillTransfer("download", remoteFile, downloaded);
    await button("下载", ".sftp-transfer-panel").click();
    await browser.waitUntil(async () => {
      const result = $(".sftp-transfer-result");
      return (
        (await result.isExisting()) && (await result.getText()).includes("下载")
      );
    });
    expect(sha256(await readFile(downloaded))).toBe(sourceHash);
  });

  it("round-trips a nested directory including empty directories", async () => {
    const sourceDirectory = path.join(localRoot, "tree");
    await mkdir(path.join(sourceDirectory, "deep", "a"), { recursive: true });
    await mkdir(path.join(sourceDirectory, "empty"));
    const nestedContents = randomBytes(32 * 1024);
    await writeFile(
      path.join(sourceDirectory, "deep", "a", "nested.bin"),
      nestedContents,
    );
    await fillTransfer("upload", sourceDirectory, `${remoteRoot}/tree`);
    await button("上传", ".sftp-transfer-panel").click();
    await expect($(".sftp-transfer-result")).toHaveText(
      expect.stringContaining("1 个文件"),
    );

    const destination = path.join(localRoot, "tree-download");
    await fillTransfer("download", `${remoteRoot}/tree`, destination);
    await button("下载", ".sftp-transfer-panel").click();
    await browser.waitUntil(async () => {
      const result = $(".sftp-transfer-result");
      return (
        (await result.isExisting()) && (await result.getText()).includes("下载")
      );
    });
    expect(
      sha256(await readFile(path.join(destination, "deep", "a", "nested.bin"))),
    ).toBe(sha256(nestedContents));
    const { stat } = await import("node:fs/promises");
    expect((await stat(path.join(destination, "empty"))).isDirectory()).toBe(
      true,
    );
  });
});

async function fillTransfer(
  direction: "upload" | "download",
  source: string,
  target: string,
) {
  const labels =
    direction === "upload"
      ? ["上传本地源文件", "上传远端目标"]
      : ["下载远端源文件", "下载本地目标"];
  await $(`input[aria-label="${labels[0]}"]`).setValue(source);
  await $(`input[aria-label="${labels[1]}"]`).setValue(target);
}

async function disconnectIfConnected() {
  const disconnect = button("断开", ".connection-form");
  if (!(await disconnect.isExisting())) return;
  await disconnect.click();
  await browser.waitUntil(
    async () =>
      !(await button("断开", ".connection-form").isExisting()) ||
      (await $("button=断开并关闭").isDisplayed()),
  );
  const confirm = $("button=断开并关闭");
  if (await confirm.isExisting()) await confirm.click();
  await browser.waitUntil(
    async () => !(await button("断开", ".connection-form").isExisting()),
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated SSH fixture variable: ${name}`);
  return value;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function button(label: string, scope = "body") {
  // Ant Design inserts a space between two Chinese characters in button text.
  return $(scope).$(
    `.//button[translate(normalize-space(.), " ", "")="${label}"]`,
  );
}
