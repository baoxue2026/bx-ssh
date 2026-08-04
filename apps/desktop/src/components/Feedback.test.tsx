import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppDialog,
  EmptyState,
  ErrorBoundary,
  FeedbackNotice,
  LoadingState,
} from "./Feedback";
import { useAsyncAction } from "./useAsyncAction";

afterEach(() => cleanup());

describe("feedback components", () => {
  it("exposes consistent live-region contracts", () => {
    render(
      <>
        <FeedbackNotice type="error" message="Request failed" />
        <FeedbackNotice type="success" message="Request complete" />
        <LoadingState label="Loading" />
        <EmptyState title="No results" />
      </>,
    );

    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    expect(
      screen.getByText("Request complete").closest("[role='status']"),
    ).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByText("Loading").closest("[role='status']"),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByText("No results").closest("[role='status']"),
    ).toHaveAttribute("aria-live", "polite");
  });

  it("keeps focus inside a dialog and returns it after Escape", async () => {
    render(<DialogProbe />);

    const trigger = screen.getByRole("button", { name: "Open dialog" });
    fireEvent.click(trigger);

    expect(
      await screen.findByRole("dialog", { name: "Confirm action" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Confirm action" }),
    ).toHaveAccessibleDescription("This action needs confirmation.");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    const dialog = screen.getByRole("dialog", { name: "Confirm action" });
    fireEvent.keyDown(dialog.parentElement!, {
      key: "Escape",
      keyCode: 27,
      which: 27,
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Confirm action" }),
      ).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it("prevents duplicate async actions until the first settles", async () => {
    let resolveAction: (() => void) | undefined;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );

    render(<AsyncActionProbe action={action} />);
    const button = screen.getByRole("button", { name: "Run" });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByText("Pending")).toBeInTheDocument();

    await act(async () => {
      resolveAction?.();
    });
    await waitFor(() => expect(screen.getByText("Run")).toBeInTheDocument());

    fireEvent.click(button);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("renders a recoverable error boundary fallback", () => {
    let shouldThrow = true;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const suppressWindowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", suppressWindowError);

    render(
      <ErrorBoundary
        fallback={(_, reset) => (
          <button
            type="button"
            onClick={() => {
              shouldThrow = false;
              reset();
            }}
          >
            Recover
          </button>
        )}
      >
        <ThrowingChild shouldThrow={() => shouldThrow} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(screen.getByText("Recovered")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
    window.removeEventListener("error", suppressWindowError);
    errorSpy.mockRestore();
  });
});

function DialogProbe() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <AppDialog
        open={open}
        title="Confirm action"
        description="This action needs confirmation."
        returnFocusRef={triggerRef}
        onClose={() => setOpen(false)}
        footer={
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        }
      >
        Dialog content
      </AppDialog>
    </>
  );
}

function AsyncActionProbe({ action }: { action: () => Promise<void> }) {
  const { execute, pending } = useAsyncAction(action);
  return (
    <button type="button" onClick={() => void execute()}>
      {pending ? "Pending" : "Run"}
    </button>
  );
}

function ThrowingChild({ shouldThrow }: { shouldThrow(): boolean }) {
  if (shouldThrow()) {
    throw new Error("test failure");
  }
  return <span>Recovered</span>;
}
