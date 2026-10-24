import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Button } from "../components/ui/button";
import { TooltipProvider, WithTooltip } from "../components/ui/tooltip";

/**
 * A closed tooltip mounts none of base-ui's machinery: the trigger attributes
 * appear only once the pointer enters or focus lands, and the element under
 * them is the same node throughout — never wrapped, never remounted — while
 * that first intent still opens the tooltip as it always did.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TRIGGER_ATTR = "data-base-ui-tooltip-trigger";

/** The pointer arriving on `el`, in the order a browser dispatches it. */
function hover(el: Element) {
  fireEvent.pointerOver(el, { pointerType: "mouse" });
  fireEvent.mouseOver(el);
  // React does not listen to `mouseenter`; base-ui does, natively.
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  fireEvent.mouseMove(el, { movementX: 4, movementY: 4 });
}

function leave(el: Element, to: Element = document.body) {
  fireEvent.pointerOut(el, { pointerType: "mouse", relatedTarget: to });
  fireEvent.mouseOut(el, { relatedTarget: to });
  el.dispatchEvent(
    new MouseEvent("mouseleave", { bubbles: false, relatedTarget: to }),
  );
}

describe("WithTooltip defers its machinery", () => {
  it("mounts nothing while closed, keeping the element's own attributes", () => {
    render(
      <TooltipProvider>
        <Button aspect="icon" tooltip="Copy">
          c
        </Button>
        <Button tooltip="Save">Save</Button>
      </TooltipProvider>,
    );
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.getAttribute("data-tooltip")).toBe("Copy");
    expect(copy.getAttribute("aria-label")).toBe("Copy");
    expect(document.querySelectorAll(`[${TRIGGER_ATTR}]`)).toHaveLength(0);
  });

  it("opens on the first hover without remounting the element", () => {
    const refs: (HTMLElement | null)[] = [];
    render(
      <TooltipProvider delay={0}>
        <WithTooltip content="Hello">
          <button type="button" ref={(el) => void refs.push(el)}>
            target
          </button>
        </WithTooltip>
      </TooltipProvider>,
    );
    const el = screen.getByRole("button", { name: "target" });
    act(() => hover(el));
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(el.isConnected).toBe(true);
    expect(el.hasAttribute(TRIGGER_ATTR)).toBe(true);
    expect(el.getAttribute("data-tooltip")).toBe("Hello");
    // One attach, never a detach: the consumer's ref saw one node.
    expect(refs).toEqual([el]);
  });

  it("waits the provider's delay on the first hover", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={300}>
        <WithTooltip content="Later">
          <button type="button">target</button>
        </WithTooltip>
      </TooltipProvider>,
    );
    const el = screen.getByRole("button", { name: "target" });
    act(() => hover(el));
    expect(screen.queryByText("Later")).toBeNull();
    act(() => void vi.advanceTimersByTime(350));
    expect(screen.getByText("Later")).toBeTruthy();
  });

  it("skips the delay moving to a never-hovered neighbour", () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider delay={300}>
        <WithTooltip content="First">
          <button type="button">a</button>
        </WithTooltip>
        <WithTooltip content="Second">
          <button type="button">b</button>
        </WithTooltip>
      </TooltipProvider>,
    );
    const a = screen.getByRole("button", { name: "a" });
    const b = screen.getByRole("button", { name: "b" });
    act(() => hover(a));
    act(() => void vi.advanceTimersByTime(350));
    expect(screen.getByText("First")).toBeTruthy();
    expect(b.hasAttribute(TRIGGER_ATTR)).toBe(false);
    act(() => {
      leave(a, b);
      hover(b);
    });
    // No timer advanced: the group's instant phase opened it at once.
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("opens on the first focus, keeping focus on the element", () => {
    render(
      <TooltipProvider delay={0}>
        <WithTooltip content="Focused">
          <button type="button">target</button>
        </WithTooltip>
      </TooltipProvider>,
    );
    const el = screen.getByRole("button", { name: "target" });
    act(() => el.focus());
    expect(document.activeElement).toBe(el);
    expect(screen.getByText("Focused")).toBeTruthy();
  });

  it("runs the element's own handlers alongside the tooltip's", () => {
    const onPointerEnter = vi.fn();
    const onFocus = vi.fn();
    render(
      <TooltipProvider delay={0}>
        <WithTooltip content="Tip">
          <button
            type="button"
            onPointerEnter={onPointerEnter}
            onFocus={onFocus}
          >
            target
          </button>
        </WithTooltip>
      </TooltipProvider>,
    );
    const el = screen.getByRole("button", { name: "target" });
    act(() => hover(el));
    act(() => el.focus());
    act(() => {
      leave(el);
      hover(el);
    });
    expect(onPointerEnter).toHaveBeenCalledTimes(2);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("pins on click once armed", () => {
    render(
      <TooltipProvider delay={0}>
        <WithTooltip content="Pinned" pinOnClick>
          <button type="button">target</button>
        </WithTooltip>
      </TooltipProvider>,
    );
    const el = screen.getByRole("button", { name: "target" });
    act(() => hover(el));
    expect(screen.getByText("Pinned")).toBeTruthy();
    act(() => el.click());
    act(() => leave(el));
    expect(screen.getByText("Pinned")).toBeTruthy();
  });
});
