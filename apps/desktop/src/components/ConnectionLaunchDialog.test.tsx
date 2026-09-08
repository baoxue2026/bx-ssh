import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { ConnectionLaunchDialog } from "./ConnectionLaunchDialog";

describe("ConnectionLaunchDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the three password storage modes mutually exclusive", () => {
    const onSubmitPassword = vi.fn();
    render(
      <ConnectionLaunchDialog
        connectionName="生产服务器"
        endpoint="deploy@example.com:22"
        pending={false}
        step="password"
        onCancel={vi.fn()}
        onConfirmFingerprint={vi.fn()}
        onSubmitPassword={onSubmitPassword}
      />,
    );

    const sessionMode = screen.getByRole("radio", { name: "仅本次" });
    const vaultMode = screen.getByRole("radio", { name: "保存到凭据库" });
    expect(screen.getByRole("radio", { name: "每次询问" })).toBeChecked();
    fireEvent.click(sessionMode);
    expect(sessionMode).toBeChecked();
    expect(vaultMode).not.toBeChecked();

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /连\s*接/ }));
    expect(onSubmitPassword).toHaveBeenCalledWith("secret", "session");
  });

  it("does not submit or save anything when authentication is cancelled", () => {
    const onSubmitPassword = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConnectionLaunchDialog
        connectionName="生产服务器"
        endpoint="deploy@example.com:22"
        pending={false}
        step="password"
        onCancel={onCancel}
        onConfirmFingerprint={vi.fn()}
        onSubmitPassword={onSubmitPassword}
      />,
    );

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmitPassword).not.toHaveBeenCalled();
  });

  it("renders echoed and hidden keyboard-interactive prompts", () => {
    const onSubmit = vi.fn();
    render(
      <ConnectionLaunchDialog
        connectionName="生产服务器"
        endpoint="deploy@example.com:22"
        pending={false}
        step="keyboardInteractive"
        keyboardPrompt={{
          type: "prompt",
          attemptId: "attempt-1",
          name: "PAM",
          instructions: "请完成二次认证",
          prompts: [
            { prompt: "验证码", echo: true },
            { prompt: "一次性密码", echo: false },
          ],
        }}
        onCancel={vi.fn()}
        onConfirmFingerprint={vi.fn()}
        onSubmitPassword={vi.fn()}
        onSubmitKeyboardInteractive={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByLabelText("一次性密码"), {
      target: { value: "otp-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /连\s*接/ }));
    expect(onSubmit).toHaveBeenCalledWith(["1234", "otp-secret"]);
  });
});
