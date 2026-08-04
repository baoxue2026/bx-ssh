import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ConfigProvider } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import {
  ConnectionEditorDialog,
  type ConnectionEditorValue,
} from "./ConnectionEditorDialog";

const editingValue: ConnectionEditorValue = {
  config: {
    id: "connection-production",
    groupId: "group-production",
    name: "生产服务器",
    host: "2001:db8::10",
    port: 2222,
    username: "deploy",
    notes: "核心服务",
    color: "#1677ff",
    authMethod: "privateKey",
    credentialRef: null,
    keyReferenceId: "key-production",
  },
  settings: {
    connectTimeoutSecs: 15,
    keepAliveSecs: 45,
  },
};

describe("ConnectionEditorDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    cleanup();
  });

  it("uses product defaults for a new connection", () => {
    renderEditor();

    expect(
      screen.getByRole("dialog", { name: "新建连接" }),
    ).toBeInTheDocument();
    expect(field("connection-port")).toHaveValue("22");
    expect(
      document.querySelector('label[for="connection-port"]'),
    ).toHaveTextContent("端口");
    clickTab("authentication");
    expect(authRadio("password")).toBeChecked();
  });

  it("restores configuration and settings when editing", async () => {
    renderEditor({ initialValue: editingValue });

    expect(
      screen.getByRole("dialog", { name: "编辑连接" }),
    ).toBeInTheDocument();
    expect(field("connection-name")).toHaveValue("生产服务器");
    expect(field("connection-host")).toHaveValue("2001:db8::10");
    expect(field("connection-port")).toHaveValue("2222");

    clickTab("authentication");
    expect(authRadio("privateKey")).toBeChecked();
    expect(field("connection-key-reference")).toHaveValue("key-production");

    clickTab("settings");
    expect(field("connection-timeout")).toHaveValue("15");
    expect(field("connection-keep-alive")).toHaveValue("45");
  });

  it("shows invalid host and port errors next to fields and on the tab", async () => {
    renderEditor();
    fillRequiredBasicFields({ host: "https://example.com/path", port: "0" });

    submitForm();

    await waitFor(() =>
      expect(
        document.getElementById("connection-host-error"),
      ).toHaveTextContent("请输入有效的 IPv4、裸 IPv6 或域名"),
    );
    expect(document.getElementById("connection-port-error")).toHaveTextContent(
      "端口必须是 1 到 65535 之间的整数",
    );
    expect(field("connection-host")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("基础信息页签存在错误")).toBeInTheDocument();
  });

  it("moves authentication errors to the authentication tab", async () => {
    renderEditor();
    fillRequiredBasicFields();
    clickTab("authentication");
    fireEvent.click(authRadio("privateKey"));
    clickTab("basic");

    submitForm();

    await waitFor(() =>
      expect(tab("authentication")).toHaveAttribute("aria-selected", "true"),
    );
    expect(field("connection-key-reference")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("preserves authentication input while switching methods", () => {
    renderEditor();
    clickTab("authentication");

    fireEvent.change(field("connection-credential-ref"), {
      target: { value: "credential-root" },
    });
    fireEvent.click(authRadio("privateKey"));
    fireEvent.change(field("connection-key-reference"), {
      target: { value: "key-ed25519" },
    });
    fireEvent.click(authRadio("keyboardInteractive"));
    fireEvent.click(authRadio("password"));

    expect(field("connection-credential-ref")).toHaveValue("credential-root");
    fireEvent.click(authRadio("privateKey"));
    expect(field("connection-key-reference")).toHaveValue("key-ed25519");
  });

  it("submits the typed contract without a plaintext password field", async () => {
    const onSubmit = vi.fn();
    renderEditor({ onSubmit });
    fillRequiredBasicFields({ host: "server.example.com", port: "22" });
    clickTab("authentication");
    fireEvent.change(field("connection-credential-ref"), {
      target: { value: "credential-root" },
    });
    clickTab("settings");
    fireEvent.change(field("connection-timeout"), {
      target: { value: "12" },
    });
    fireEvent.change(field("connection-keep-alive"), {
      target: { value: "0" },
    });

    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const result = onSubmit.mock.calls[0][0] as ConnectionEditorValue;
    expect(onSubmit.mock.calls[0][1]).toBe("save");
    expect(result).toMatchObject({
      config: {
        authMethod: "password",
        credentialRef: "credential-root",
        groupId: null,
        host: "server.example.com",
        keyReferenceId: null,
        name: "测试连接",
        notes: null,
        port: 22,
        username: "root",
      },
      settings: {
        connectTimeoutSecs: 12,
        keepAliveSecs: 0,
      },
    });
    expect(result.config.id).toMatch(/^connection-/);
    expect(hasPropertyNamed(result, "password")).toBe(false);
  });

  it("distinguishes save and save-and-connect actions", async () => {
    const onSubmit = vi.fn();
    renderEditor({ onSubmit });
    fillRequiredBasicFields();

    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ name: "测试连接" }),
        }),
        "saveAndConnect",
      ),
    );
  });

  it("locks dialog actions while a save is pending", () => {
    renderEditor({ pending: true });

    expect(screen.getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存并连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });
});

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof ConnectionEditorDialog>> = {},
) {
  return render(
    <ConfigProvider
      theme={{ token: { motion: false } }}
      wave={{ disabled: true }}
    >
      <ConnectionEditorDialog
        open
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        {...overrides}
      />
    </ConfigProvider>,
  );
}

function fillRequiredBasicFields({
  host = "127.0.0.1",
  port = "22",
}: {
  host?: string;
  port?: string;
} = {}) {
  fireEvent.change(field("connection-name"), {
    target: { value: "测试连接" },
  });
  fireEvent.change(field("connection-host"), {
    target: { value: host },
  });
  fireEvent.change(field("connection-port"), {
    target: { value: port },
  });
  fireEvent.change(field("connection-username"), {
    target: { value: "root" },
  });
}

function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.getElementById(id);
  if (!(
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  )) {
    throw new Error(`Missing form field: ${id}`);
  }
  return element;
}

function tab(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-node-key="${key}"] [role="tab"]`,
  );
  if (!element) throw new Error(`Missing tab: ${key}`);
  return element;
}

function clickTab(key: string) {
  fireEvent.click(tab(key));
}

function authRadio(value: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!element) throw new Error(`Missing authentication option: ${value}`);
  return element;
}

function submitForm() {
  const form = document.querySelector<HTMLFormElement>(
    'form[id^="connection-editor-"]',
  );
  if (!form) throw new Error("Missing connection editor form");
  fireEvent.submit(form);
}

function hasPropertyNamed(value: unknown, propertyName: string): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      key === propertyName || hasPropertyNamed(nested, propertyName),
  );
}
