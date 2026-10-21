import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { OverflowPanel } from "../internal/overflow-panel";

/**
 * A parked occupant's own popup (a popover its button opened) is the innermost
 * layer: while it is open, an outside press or Esc is its to handle, and the
 * panel must not dismiss under it — that would hide the popup's trigger.
 */

afterEach(cleanup);

function mount(childPopupOpen: boolean) {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const onDismiss = vi.fn();
  render(
    <OverflowPanel
      open
      anchor={anchor}
      label="More"
      dockRef={() => {}}
      dockAttrs={{}}
      hasOpenChildPopup={() => childPopupOpen}
      onDismiss={onDismiss}
    />,
  );
  return onDismiss;
}

describe("OverflowPanel under an open child popup", () => {
  it("dismisses on an outside press and Esc when no child popup is open", () => {
    const onDismiss = mount(false);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("stays open while a child popup is open", () => {
    const onDismiss = mount(true);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
