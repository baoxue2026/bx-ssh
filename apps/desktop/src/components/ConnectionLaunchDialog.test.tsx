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
});
