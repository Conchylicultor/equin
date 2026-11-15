import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { SwipeCompare } from "../internal/swipe-compare";

afterEach(cleanup);

function separator(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="separator"]');
  if (!el) throw new Error("no separator");
  return el;
}

const value = () => separator().getAttribute("aria-valuenow");

const key = (k: string, shiftKey = false) =>
  fireEvent.keyDown(separator(), { key: k, shiftKey });

describe("SwipeCompare (swipe)", () => {
  it("starts centred when uncontrolled and moves on its own", () => {
    render(<SwipeCompare mode="swipe" before="A" after="B" />);
    expect(value()).toBe("50");
    key("ArrowRight");
    expect(value()).toBe("52");
    key("ArrowLeft", true);
    expect(value()).toBe("42");
  });

  it("clamps the keys to the track and jumps with Home / End", () => {
    const onAtChange = vi.fn();
    render(
      <SwipeCompare
        mode="swipe"
        before="A"
        after="B"
        onAtChange={onAtChange}
      />,
    );
    key("End");
    expect(value()).toBe("100");
    key("ArrowRight", true);
    expect(value()).toBe("100");
    expect(onAtChange).toHaveBeenLastCalledWith(1);
    key("Home");
    expect(value()).toBe("0");
    key("ArrowLeft");
    expect(value()).toBe("0");
    expect(onAtChange).toHaveBeenLastCalledWith(0);
  });

  it("is driven by `at` when controlled, reporting moves without taking them", () => {
    const onAtChange = vi.fn();
    const { rerender } = render(
      <SwipeCompare
        mode="swipe"
        before="A"
        after="B"
        at={0.3}
        onAtChange={onAtChange}
      />,
    );
    expect(value()).toBe("30");
    key("ArrowRight", true);
    expect(onAtChange).toHaveBeenLastCalledWith(expect.closeTo(0.4, 6));
    // The parent did not apply it: the divider stays where `at` says.
    expect(value()).toBe("30");
    rerender(
      <SwipeCompare
        mode="swipe"
        before="A"
        after="B"
        at={0.4}
        onAtChange={onAtChange}
      />,
    );
    expect(value()).toBe("40");
  });

  it("follows a parent that applies every move", () => {
    function Host() {
      const [at, setAt] = useState(0.5);
      return (
        <SwipeCompare
          mode="swipe"
          before="A"
          after="B"
          at={at}
          onAtChange={setAt}
        />
      );
    }
    render(<Host />);
    key("ArrowLeft");
    key("ArrowLeft");
    expect(value()).toBe("46");
    fireEvent.doubleClick(separator());
    expect(value()).toBe("50");
  });

  it("leaves keys it does not answer alone", () => {
    render(<SwipeCompare mode="swipe" before="A" after="B" />);
    const unhandled = fireEvent.keyDown(separator(), { key: "a" });
    expect(unhandled).toBe(true);
    const handled = fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(handled).toBe(false);
  });
});

describe("SwipeCompare (flip)", () => {
  it("toggles which side shows on click and Space", () => {
    render(<SwipeCompare mode="flip" before="A" after="B" />);
    const surface = document.querySelector<HTMLElement>('[role="button"]')!;
    expect(surface.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(surface);
    expect(surface.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(surface, { key: " " });
    expect(surface.getAttribute("aria-pressed")).toBe("true");
  });
});
