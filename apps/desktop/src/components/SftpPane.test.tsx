import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { RemoteDirectoryListing } from "../ipc/bindings";
import { SftpPane } from "./SftpPane";

const directory: RemoteDirectoryListing = {
  path: "/home/bx",
  entries: [
    {
      name: "notes.txt",
      path: "/home/bx/notes.txt",
      kind: "file",
      size: 12,
      modifiedAt: null,
      permissions: 0o644,
    },
    {
      name: ".env",
      path: "/home/bx/.env",
      kind: "file",
      size: 8,
      modifiedAt: null,
      permissions: 0o600,
    },
  ],
};

function renderPane(
  overrides: Partial<React.ComponentProps<typeof SftpPane>> = {},
) {
  return render(
    <SftpPane
      busy={false}
      canGoBack={false}
      canGoForward={false}
      connected
      directory={directory}
      endpoint="bx@example.com:22"
      transferResult={null}
      onBack={async () => undefined}
      onDownload={async () => undefined}
      onForward={async () => undefined}
      onNavigate={async () => undefined}
      onRefresh={async () => undefined}
      onUpload={async () => undefined}
      {...overrides}
    />,
  );
}

describe("SftpPane", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => cleanup());

  it("triggers back and forward navigation callbacks", () => {
    const onBack = vi.fn(async () => undefined);
    const onForward = vi.fn(async () => undefined);
    renderPane({ canGoBack: true, canGoForward: true, onBack, onForward });

    fireEvent.click(screen.getByRole("button", { name: "返回上一个远端目录" }));
    fireEvent.click(
      screen.getByRole("button", { name: "前进到下一个远端目录" }),
    );

    expect(onBack).toHaveBeenCalledOnce();
    expect(onForward).toHaveBeenCalledOnce();
  });

  it("disables navigation buttons when there is no history", () => {
    renderPane();

    expect(
      screen.getByRole("button", { name: "返回上一个远端目录" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "前进到下一个远端目录" }),
    ).toBeDisabled();
  });

  it("hides dot files by default and reveals them on demand", () => {
    renderPane();

    expect(screen.getByText("notes.txt")).toBeVisible();
    expect(screen.queryByText(".env")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "显示隐藏文件" }));

    expect(screen.getByText(".env")).toBeVisible();
  });
});
