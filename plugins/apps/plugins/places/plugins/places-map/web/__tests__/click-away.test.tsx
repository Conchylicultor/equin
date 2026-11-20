import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useClickAway } from "../internal/use-click-away";

const PANELS: never[] = [];

function Screen({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  useClickAway({ active: true, region, panels: PANELS, onDismiss });
  return <div ref={region}>{children}</div>;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

describe("useClickAway", () => {
  it("dismisses on a click in the region", () => {
    const onDismiss = vi.fn();
    const { getByText } = render(
      <Screen onDismiss={onDismiss}>
        <span>map</span>
      </Screen>,
    );
    click(getByText("map"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is not a click away inside a dialog in the region (the map vendor's own)", () => {
    const onDismiss = vi.fn();
    const { getByText } = render(
      <Screen onDismiss={onDismiss}>
        <dialog open>
          <button type="button">Close</button>
        </dialog>
      </Screen>,
    );
    click(getByText("Close"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("is not a click away when the click opened a modal dialog in the screen", () => {
    const onDismiss = vi.fn();
    const { getByText, container } = render(
      <Screen onDismiss={onDismiss}>
        <button type="button">Keyboard shortcuts</button>
        <dialog />
      </Screen>,
    );
    const dialog = container.querySelector("dialog");
    // jsdom has no showModal(): stand in for the modal Google opens on click.
    const spy = vi
      .spyOn(container.firstElementChild!, "querySelector")
      .mockImplementation(((sel: string) =>
        sel === "dialog:modal"
          ? dialog
          : null) as typeof Element.prototype.querySelector);
    try {
      click(getByText("Keyboard shortcuts"));
    } finally {
      spy.mockRestore();
    }
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("still dismisses while the page is fullscreen (bare :modal would match it)", () => {
    const onDismiss = vi.fn();
    const { getByText, container } = render(
      <Screen onDismiss={onDismiss}>
        <span>fullscreen map</span>
      </Screen>,
    );
    const spy = vi
      .spyOn(container.firstElementChild!, "querySelector")
      .mockImplementation(((sel: string) =>
        sel === ":modal"
          ? document.documentElement
          : null) as typeof Element.prototype.querySelector);
    try {
      click(getByText("fullscreen map"));
    } finally {
      spy.mockRestore();
    }
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
