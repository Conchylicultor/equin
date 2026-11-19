import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  Dialog,
  DialogContent,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import { ConfirmDialogBody } from "../components/confirm-dialog-body";

/**
 * The keyboard contract of the destructive confirm.
 *
 * The rule it encodes is a safety one, not a convenience one: a destructive
 * action must not be reachable by a reflex. Focus opens on Cancel, so a bare
 * Enter presses Cancel — and the confirm accelerator therefore has to ask for a
 * modifier held down, which no reflex supplies. Both halves are asserted here,
 * because a change that made Enter alone confirm would look like an improvement
 * ("the dialog is faster now") while removing the guard the dialog exists for.
 *
 * jsdom rather than a browser: this is event handling, not layout. The layout
 * half of the dialog — where the box is and what counts as "outside" it — is
 * checked against the real engine in
 * `primitives/css/ui-kit/e2e/dialog-box.ts`, because no DOM implementation can
 * answer it.
 *
 * The body renders inside the real `Dialog`/`DialogContent` shell rather than
 * bare: `DialogTitle` reads base-ui's root context, so a bare render throws —
 * and the shell is what the imperative host mounts anyway, so this is the
 * composition that actually ships.
 */

afterEach(cleanup);

function renderBody(onConfirm: () => void | Promise<unknown>) {
  const onClose = vi.fn();
  const onConfirmed = vi.fn();
  render(
    <Dialog open>
      <DialogContent size="sm">
        <ConfirmDialogBody
          title="Delete the thing?"
          confirmLabel="Delete"
          onConfirm={onConfirm}
          onClose={onClose}
          onConfirmed={onConfirmed}
        />
      </DialogContent>
    </Dialog>,
  );
  return { onClose, onConfirmed, body: screen.getByText("Delete the thing?") };
}

describe("confirm dialog keyboard", () => {
  it("confirms on meta+Enter from anywhere in the dialog", async () => {
    const onConfirm = vi.fn();
    const { body, onConfirmed } = renderBody(onConfirm);

    fireEvent.keyDown(body, { key: "Enter", metaKey: true });

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("confirms on ctrl+Enter, for a machine with no meta key", async () => {
    const onConfirm = vi.fn();
    const { body } = renderBody(onConfirm);

    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true });

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("does NOT confirm on a bare Enter — the reflex keystroke", () => {
    const onConfirm = vi.fn();
    const { body } = renderBody(onConfirm);

    fireEvent.keyDown(body, { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does NOT confirm on a modified key that is not Enter", () => {
    const onConfirm = vi.fn();
    const { body } = renderBody(onConfirm);

    fireEvent.keyDown(body, { key: "a", metaKey: true });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cannot fire the action twice while the first is still in flight", async () => {
    let release!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { body, onConfirmed } = renderBody(onConfirm);

    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    // Held down, or pressed again because nothing looked like it happened yet.
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
  });

  // An `EndpointError` on purpose: a failure of any OTHER kind is deliberately
  // re-filed to the crash reporter (`void Promise.reject(err)`), which in a test
  // process surfaces as an unhandled rejection and fails the run — correctly.
  // A failed mutation is the real shape of this case anyway.
  it("keeps the dialog open and shows the error when the action fails", async () => {
    const onConfirm = vi.fn(() =>
      Promise.reject(
        new EndpointError("POST /api/test", 500, "the server said no"),
      ),
    );
    const { body, onClose, onConfirmed } = renderBody(onConfirm);

    fireEvent.keyDown(body, { key: "Enter", metaKey: true });

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("the server said no"),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
