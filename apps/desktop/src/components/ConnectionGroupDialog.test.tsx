import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { ConnectionGroup } from "../ipc/bindings";
import { ConnectionGroupDialog } from "./ConnectionGroupDialog";

const editingGroup: ConnectionGroup = {
  id: "group-production",
  name: "生产环境",
  color: "#1677ff",
  sortOrder: 2,
  isCollapsed: true,
  revision: 4,
};

describe("ConnectionGroupDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("validates the name and color before submitting", () => {
    const onSubmit = vi.fn();
    render(
      <ConnectionGroupDialog open onClose={vi.fn()} onSubmit={onSubmit} />,
    );
    const dialog = screen.getByRole("dialog", { name: "新建连接分组" });
    const nameInput = within(dialog).getByRole("textbox", {
      name: "分组名称",
    });
    const colorInput = within(dialog).getByRole("textbox", {
      name: "分组颜色值",
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*定/ }));
    expect(screen.getByText("此项为必填项")).toBeInTheDocument();
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(nameInput, {
      target: { value: "  临时环境  " },
    });
    fireEvent.change(colorInput, {
      target: { value: "#12" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*定/ }));

    expect(screen.getByText("颜色必须为 #RRGGBB 格式")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a trimmed new group and preserves edit metadata", () => {
    const onSubmit = vi.fn();
    render(
      <ConnectionGroupDialog
        initialValue={editingGroup}
        open
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "编辑连接分组" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "分组名称" }), {
      target: { value: "  生产集群  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /确\s*定/ }));

    expect(onSubmit).toHaveBeenCalledWith({
      ...editingGroup,
      name: "生产集群",
    });
  });

  it("clears an existing group color", () => {
    render(
      <ConnectionGroupDialog
        initialValue={editingGroup}
        open
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const colorValue = screen.getByRole("textbox", { name: "分组颜色值" });
    const clearButton = screen.getByRole("button", { name: "清除分组颜色" });

    expect(colorValue).toHaveValue("#1677ff");
    fireEvent.click(clearButton);

    expect(colorValue).toHaveValue("");
    expect(clearButton).toBeDisabled();
  });
});
