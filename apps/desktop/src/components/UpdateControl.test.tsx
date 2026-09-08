import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { IpcError, type IpcErrorCode } from "../ipc/client";
import { UpdateControl } from "./UpdateControl";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  cancelUpdate: vi.fn(),
}));

vi.mock("../ipc/client", () => {
  class MockIpcError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "IpcError";
      this.code = code;
    }
  }

  return {
    IpcError: MockIpcError,
    ipc: mocks,
  };
});

describe("UpdateControl", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mocks.checkForUpdate.mockReset();
    mocks.installUpdate.mockReset();
    mocks.cancelUpdate.mockReset();
    mocks.cancelUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("shows download progress and returns to a retryable state after cancellation", async () => {
    const update = {
      currentVersion: "0.1.0",
      version: "0.1.1",
      notes: null,
      publishedAt: null,
    };
    let rejectInstall: ((error: unknown) => void) | undefined;
    mocks.checkForUpdate.mockResolvedValue(update);
    mocks.installUpdate.mockImplementation((...args: unknown[]) => {
      void args;
      return new Promise((_, reject) => {
        rejectInstall = reject;
      });
    });

    render(<UpdateControl currentVersion="0.1.0" />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    fireEvent.click(await screen.findByRole("button", { name: "下载并安装" }));

    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledOnce());
    const onEvent = mocks.installUpdate.mock.calls[0][1] as (event: {
      type: string;
      contentLength?: number | null;
      chunkLength?: number;
    }) => void;
    act(() => {
      onEvent({ type: "started", contentLength: 2048 });
      onEvent({ type: "progress", chunkLength: 1024 });
    });
    expect(screen.getByText("1.0 KiB / 2.0 KiB")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "取消下载" }));
    expect(mocks.cancelUpdate).toHaveBeenCalledOnce();

    await act(async () => {
      rejectInstall?.(new IpcError("update_cancelled", "cancelled"));
    });
    expect(
      await screen.findByText("更新下载已取消，可以重新尝试。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "下载并安装" }),
    ).toBeInTheDocument();
  });

  it.each<[IpcErrorCode, string]>([
    ["update_signature_invalid", "更新包签名校验失败，未安装任何内容。"],
    ["update_backup_failed", "升级前数据库备份失败，更新未安装。"],
  ])("shows a safe update error for %s", async (code, message) => {
    mocks.checkForUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      version: "0.1.1",
      notes: null,
      publishedAt: null,
    });
    mocks.installUpdate.mockRejectedValue(
      new IpcError(code, "native update failure"),
    );

    render(<UpdateControl currentVersion="0.1.0" />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    fireEvent.click(await screen.findByRole("button", { name: "下载并安装" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("retries a failed update check", async () => {
    mocks.checkForUpdate
      .mockRejectedValueOnce(new IpcError("update_unavailable", "offline"))
      .mockResolvedValueOnce(null);

    render(<UpdateControl currentVersion="0.1.0" />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("更新服务暂时不可用")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("当前版本 v0.1.0 已是最新版本。"),
    ).toBeInTheDocument();
  });

  it("warns before restarting when sessions or transfers are active", async () => {
    mocks.checkForUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      version: "0.1.1",
      notes: null,
      publishedAt: null,
    });

    render(
      <UpdateControl
        activeSessions={2}
        activeTransfers={1}
        currentVersion="0.1.0"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("更新会影响当前活动")).toBeInTheDocument();
    expect(screen.getByText("将断开 2 个活动会话。")).toBeInTheDocument();
    expect(screen.getByText("将终止 1 个文件传输。")).toBeInTheDocument();
  });
});
