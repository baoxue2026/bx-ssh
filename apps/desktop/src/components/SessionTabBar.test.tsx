import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { SessionTabBar, type SessionTab } from "./SessionTabBar";

const tabs: SessionTab[] = [
  {
    clientId: "session-1",
    connectionId: "connection-1",
    endpoint: "deploy@example.com:22",
    name: "生产服务器",
    status: "connected",
    statusLabel: "已连接",
  },
  {
    clientId: "session-2",
    connectionId: "connection-1",
    endpoint: "deploy@example.com:22",
    name: "生产服务器 (2)",
    status: "disconnected",
    statusLabel: "已断开",
  },
];

describe("SessionTabBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("renders multiple named tabs with accessible state and close actions", () => {
    render(
      <SessionTabBar
        activeClientId="session-1"
        tabs={tabs}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onRename={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const tablist = screen.getByRole("tablist", { name: "SSH 会话" });
    const renderedTabs = within(tablist).getAllByRole("tab");
    expect(renderedTabs).toHaveLength(2);
    expect(renderedTabs[0]).toHaveAttribute("aria-selected", "true");
    expect(renderedTabs[1]).toHaveAttribute("aria-selected", "false");
    expect(within(renderedTabs[0]).getByText("已连接")).toBeVisible();
    expect(within(renderedTabs[1]).getByText("已断开")).toBeVisible();
    expect(
      within(renderedTabs[1]).getByRole("button", {
        name: "关闭会话 生产服务器 (2)",
      }),
    ).toBeEnabled();
  });

  it("supports rename, selection, sorting and close callbacks", () => {
    const onClose = vi.fn();
    const onMove = vi.fn();
    const onRename = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionTabBar
        activeClientId="session-1"
        tabs={tabs}
        onClose={onClose}
        onMove={onMove}
        onRename={onRename}
        onSelect={onSelect}
      />,
    );

    const secondTab = screen.getByRole("tab", { name: /生产服务器 \(2\)/ });
    fireEvent.click(secondTab);
    expect(onSelect).toHaveBeenCalledWith(tabs[1]);

    fireEvent.keyDown(secondTab, { key: "F2" });
    const renameInput = within(secondTab).getByRole("textbox", {
      name: "重命名会话 生产服务器 (2)",
    });
    fireEvent.change(renameInput, { target: { value: "跳板机" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(tabs[1], "跳板机");

    fireEvent.click(
      within(secondTab).getByRole("button", {
        name: "向左移动会话 生产服务器 (2)",
      }),
    );
    expect(onMove).toHaveBeenCalledWith(tabs[1], "left");
    fireEvent.click(
      within(secondTab).getByRole("button", {
        name: "关闭会话 生产服务器 (2)",
      }),
    );
    expect(onClose).toHaveBeenCalledWith(tabs[1]);
  });
});
