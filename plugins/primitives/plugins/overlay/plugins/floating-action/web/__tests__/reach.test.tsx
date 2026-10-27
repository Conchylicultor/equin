import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { FloatingAction, FloatingActionFadeIn } from "../index";

/**
 * A long bar's far items are reached by sweeping along it, and a hand drifts
 * off a thin pill on the way. The panel stays open while the pointer is within
 * reach of its drawn box, and closes once it goes further.
 *
 * jsdom has no layout: the open panel is stubbed as a 300×40 box at the
 * origin; every other element has none.
 */

const PANEL = {
  left: 0,
  top: 0,
  right: 300,
  bottom: 40,
  width: 300,
  height: 40,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const box =
        this.getAttribute("data-testid") === "panel"
          ? PANEL
          : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      return { ...box, x: box.left, y: box.top, toJSON: () => ({}) };
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount() {
  const { getByLabelText } = render(
    <FloatingAction
      label="Bar"
      // Rest props land on the panel, which is how the stub finds it.
      data-testid="panel"
      trigger={<span>dot</span>}
    >
      <FloatingActionFadeIn>items</FloatingActionFadeIn>
    </FloatingAction>,
  );
  const wrapper = getByLabelText("Bar");
  fireEvent.pointerEnter(wrapper);
  return wrapper;
}

function settle() {
  act(() => {
    vi.advanceTimersByTime(1000);
  });
}

const isOpen = (el: HTMLElement) => el.hasAttribute("data-open");

describe("FloatingAction reach", () => {
  it("stays open while the pointer drifts just off the bar", () => {
    const wrapper = mount();
    fireEvent.pointerLeave(wrapper, { clientX: 20, clientY: 52 });
    fireEvent.pointerMove(document.body, { clientX: 10, clientY: 55 });
    settle();
    expect(isOpen(wrapper)).toBe(true);
  });

  it("closes once the pointer goes out of reach", () => {
    const wrapper = mount();
    fireEvent.pointerLeave(wrapper, { clientX: 20, clientY: 52 });
    fireEvent.pointerMove(document.body, { clientX: 20, clientY: 120 });
    settle();
    expect(isOpen(wrapper)).toBe(false);
  });

  it("coming back within reach before the grace ends keeps it open", () => {
    const wrapper = mount();
    fireEvent.pointerMove(document.body, { clientX: 20, clientY: 120 });
    fireEvent.pointerMove(document.body, { clientX: 20, clientY: 50 });
    settle();
    expect(isOpen(wrapper)).toBe(true);
  });

  it("closes when the pointer leaves the window from within reach", () => {
    const wrapper = mount();
    fireEvent.pointerLeave(wrapper, { clientX: 20, clientY: 52 });
    fireEvent.pointerOut(document.body, { relatedTarget: null });
    settle();
    expect(isOpen(wrapper)).toBe(false);
  });
});
