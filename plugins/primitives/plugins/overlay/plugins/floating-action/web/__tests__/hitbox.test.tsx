import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { FloatingAction, FloatingActionFadeIn } from "../index";

/**
 * The wrapper is the only way into a closed `FloatingAction` (the panel is
 * `inert`), so its size IS the hover/click target. These tests pin the rule it
 * follows: the trigger's CURRENT size plus the panel's chrome at rest — never
 * the open panel's size, and never a size frozen at mount.
 *
 * jsdom has no layout engine, so the geometry comes from a stubbed
 * `getBoundingClientRect` that plays the part of the browser: the collapsed
 * panel is its trigger plus a fixed chrome, the open panel is much bigger. The
 * shared inert `ResizeObserver` is swapped for one the test can fire, and
 * `requestAnimationFrame` runs its callback at once so the observer's debounce
 * does not need a real frame.
 */

const CHROME = { width: 10, height: 6 };
const OPEN_PANEL = { width: 300, height: 48 };

/** The trigger's laid-out size. Mutated per test to drive a resize. */
let triggerSize = { width: 20, height: 20 };
/** Whether the whole subtree has a box (false: under `display: none`). */
let rendered = true;

const observers = new Set<DrivableResizeObserver>();

class DrivableResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    observers.add(this);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this);
  }
  fire(): void {
    this.callback([], this);
  }
}

/** Deliver a resize notification to every live observer. */
function fireResize(): void {
  act(() => {
    for (const observer of [...observers]) observer.fire();
  });
}

function rect(size: { width: number; height: number }): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: size.width,
    bottom: size.height,
    width: size.width,
    height: size.height,
    toJSON: () => ({}),
  };
}

const ZERO = { width: 0, height: 0 };

function fakeLayout(el: Element): DOMRect {
  if (!rendered) return rect(ZERO);
  // The trigger's own box is the element that directly wraps the trigger node.
  if (el.firstElementChild?.getAttribute("data-testid") === "trigger") {
    return rect(triggerSize);
  }
  if (el.getAttribute("data-testid") === "panel") {
    const open = el.closest("[data-open]") !== null;
    return rect(
      open
        ? OPEN_PANEL
        : {
            width: triggerSize.width + CHROME.width,
            height: triggerSize.height + CHROME.height,
          },
    );
  }
  return rect(ZERO);
}

function mount() {
  const { container } = render(
    <FloatingAction
      // Rest props land on the panel, which is how the fake finds it.
      data-testid="panel"
      anchor="top-right"
      trigger={<span data-testid="trigger">dot</span>}
    >
      <FloatingActionFadeIn>content</FloatingActionFadeIn>
    </FloatingAction>,
  );
  return { wrapper: container.firstElementChild as HTMLElement };
}

function sizeOf(el: HTMLElement): { width: string; height: string } {
  return { width: el.style.width, height: el.style.height };
}

beforeEach(() => {
  triggerSize = { width: 20, height: 20 };
  rendered = true;
  observers.clear();
  vi.stubGlobal("ResizeObserver", DrivableResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom has no CSS zoom: every element is drawn at 1, as an unzoomed page's.
  Object.defineProperty(HTMLElement.prototype, "currentCSSZoom", {
    configurable: true,
    get: () => 1,
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return fakeLayout(this);
    },
  );
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { currentCSSZoom?: number }).currentCSSZoom;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FloatingAction hover hitbox", () => {
  it("is the collapsed panel's footprint at mount", () => {
    const { wrapper } = mount();
    expect(sizeOf(wrapper)).toEqual({ width: "30px", height: "26px" });
  });

  it("grows with the trigger while closed", () => {
    const { wrapper } = mount();
    // A bare dot becomes a pill with a count.
    triggerSize = { width: 48, height: 20 };
    fireResize();
    expect(sizeOf(wrapper)).toEqual({ width: "58px", height: "26px" });
    // ...and shrinks back when it no longer needs attention.
    triggerSize = { width: 20, height: 20 };
    fireResize();
    expect(sizeOf(wrapper)).toEqual({ width: "30px", height: "26px" });
  });

  it("never follows the open panel, nor a trigger reshaped while open", () => {
    const { wrapper } = mount();
    fireEvent.pointerEnter(wrapper);
    expect(wrapper.hasAttribute("data-open")).toBe(true);

    // The open panel is far bigger, and the trigger clips itself away (the
    // outline rail's dashes): the hitbox holds still under the morph.
    triggerSize = { width: 20, height: 0 };
    fireResize();
    expect(sizeOf(wrapper)).toEqual({ width: "30px", height: "26px" });

    // The trigger comes back grown while still open, then the panel closes:
    // the footprint is re-derived at once, with no resize needed.
    triggerSize = { width: 48, height: 20 };
    fireEvent.keyDown(wrapper, { key: "Escape" });
    expect(wrapper.hasAttribute("data-open")).toBe(false);
    expect(sizeOf(wrapper)).toEqual({ width: "58px", height: "26px" });
  });

  it("waits for a box when mounted hidden, then includes the chrome", () => {
    rendered = false;
    const { wrapper } = mount();
    fireResize();
    // Nothing to measure yet: no size is invented.
    expect(sizeOf(wrapper)).toEqual({ width: "", height: "" });

    // Shown: the trigger's first resize measures the panel at rest.
    rendered = true;
    fireResize();
    expect(sizeOf(wrapper)).toEqual({ width: "30px", height: "26px" });
  });
});
