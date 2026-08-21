import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type {
  LocalDirectoryListing,
  RemoteDirectoryListing,
} from "../ipc/bindings";
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

const localDirectory: LocalDirectoryListing = {
  path: "C:\\work",
  parentPath: "C:\\",
  entries: [
    {
      name: "assets",
      path: "C:\\work\\assets",
      kind: "directory",
      size: 0,
      modifiedAt: null,
      readonly: false,
      hidden: false,
    },
    {
      name: "upload.txt",
      path: "C:\\work\\upload.txt",
      kind: "file",
      size: 20,
      modifiedAt: null,
      readonly: false,
      hidden: false,
    },
    {
      name: ".local-env",
      path: "C:\\work\\.local-env",
      kind: "file",
      size: 4,
      modifiedAt: null,
      readonly: false,
      hidden: true,
    },
    {
      name: "archive.bin",
      path: "C:\\work\\archive.bin",
      kind: "file",
      size: 3,
      modifiedAt: null,
      readonly: false,
      hidden: false,
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
      localBusy={false}
      localDirectory={null}
      transferResult={null}
      transferId={null}
      onBack={async () => undefined}
      onDownload={async () => undefined}
      onForward={async () => undefined}
      onLocalNavigate={async () => undefined}
      onLocalRefresh={async () => undefined}
      onNavigate={async () => undefined}
      onRefresh={async () => undefined}
      onUpload={async () => undefined}
      onCancelTransfer={async () => undefined}
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
    renderPane({ localDirectory });

    expect(screen.getByText("notes.txt")).toBeVisible();
    expect(screen.queryByText(".env")).not.toBeInTheDocument();
    expect(screen.queryByText(".local-env")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "显示隐藏文件" }));

    expect(screen.getByText(".env")).toBeVisible();
    expect(screen.getByText(".local-env")).toBeVisible();
  });

  it("keeps local and remote selection independent and fills transfer paths", () => {
    renderPane({ localDirectory });

    const localPanel = screen.getByRole("region", { name: "本地文件" });
    const remotePanel = screen.getByRole("region", { name: "远端文件" });
    fireEvent.click(within(localPanel).getByText("upload.txt"));

    expect(
      within(localPanel).getByRole("row", { name: /upload\.txt/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("上传本地源文件")).toHaveValue(
      "C:\\work\\upload.txt",
    );
    expect(screen.getByLabelText("上传远端目标")).toHaveValue(
      "/home/bx/upload.txt",
    );
    expect(
      within(remotePanel).getByRole("row", { name: /notes\.txt/ }),
    ).toHaveAttribute("aria-selected", "false");

    fireEvent.click(within(remotePanel).getByText("notes.txt"));

    expect(
      within(remotePanel).getByRole("row", { name: /notes\.txt/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("下载远端源文件")).toHaveValue(
      "/home/bx/notes.txt",
    );
    expect(screen.getByLabelText("下载本地目标")).toHaveValue(
      "C:\\work\\notes.txt",
    );
    expect(
      within(localPanel).getByRole("row", { name: /upload\.txt/ }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("fills recursive transfer paths when selecting directories", () => {
    const remoteWithDirectory: RemoteDirectoryListing = {
      ...directory,
      entries: [
        ...directory.entries,
        {
          name: "releases",
          path: "/home/bx/releases",
          kind: "directory",
          size: 0,
          modifiedAt: null,
          permissions: 0o755,
        },
      ],
    };
    renderPane({ directory: remoteWithDirectory, localDirectory });

    fireEvent.click(screen.getByText("assets"));
    expect(screen.getByLabelText("上传本地源文件")).toHaveValue(
      "C:\\work\\assets",
    );
    expect(screen.getByLabelText("上传远端目标")).toHaveValue(
      "/home/bx/assets",
    );

    fireEvent.click(screen.getByText("releases"));
    expect(screen.getByLabelText("下载远端源文件")).toHaveValue(
      "/home/bx/releases",
    );
    expect(screen.getByLabelText("下载本地目标")).toHaveValue(
      "C:\\work\\releases",
    );
  });

  it("shows and cancels an active directory transfer", () => {
    const onCancelTransfer = vi.fn(async () => undefined);
    renderPane({
      transferId: "transfer-1",
      onCancelTransfer,
    });

    expect(screen.getByText("目录传输进行中")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onCancelTransfer).toHaveBeenCalledOnce();
  });

  it("sorts each panel independently by a selected column", () => {
    renderPane({ localDirectory });
    const localPanel = screen.getByRole("region", { name: "本地文件" });
    const localSizeHeader = within(localPanel).getByRole("button", {
      name: "大小",
    });

    fireEvent.click(localSizeHeader);

    const rows = within(localPanel).getAllByRole("row");
    expect(rows[1]).toHaveAccessibleName(/assets/);
    expect(rows[2]).toHaveAccessibleName(/archive\.bin/);
    expect(rows[3]).toHaveAccessibleName(/upload\.txt/);
  });

  it("accepts a local path entered in the address field", () => {
    const onLocalNavigate = vi.fn(async () => undefined);
    renderPane({ localDirectory, onLocalNavigate });
    const pathInput = screen.getByRole("textbox", { name: "本地路径" });

    fireEvent.change(pathInput, { target: { value: "C:\\other" } });
    fireEvent.keyDown(pathInput, { key: "Enter", code: "Enter" });

    expect(onLocalNavigate).toHaveBeenCalledWith("C:\\other");
  });
});
