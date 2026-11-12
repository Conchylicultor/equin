import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, fireEvent, act } from "@testing-library/react";
import {
  InputModalityTracker,
  trackInputModality,
} from "../theme/input-modality";

afterEach(cleanup);

const MARK = "data-pointer-focus";

function setup() {
  const { getByText } = render(
    <>
      <InputModalityTracker />
      <button>A</button>
      <button>B</button>
    </>,
  );
  return { a: getByText("A"), b: getByText("B") };
}

describe("InputModalityTracker", () => {
  it("marks only the focused element, and only in pointer modality", () => {
    const { a, b } = setup();
    // Keyboard-first: nothing is marked, so a Tab's focus is ringed.
    act(() => a.focus());
    expect(a.hasAttribute(MARK)).toBe(false);

    // A pointer press marks what is focused; focus moving moves the mark.
    fireEvent.pointerDown(document);
    expect(a.hasAttribute(MARK)).toBe(true);
    act(() => b.focus());
    expect(a.hasAttribute(MARK)).toBe(false);
    expect(b.hasAttribute(MARK)).toBe(true);
    expect(document.querySelectorAll(`[${MARK}]`)).toHaveLength(1);

    // A navigation key drops it; Escape (not navigation) does not.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(b.hasAttribute(MARK)).toBe(true);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(b.hasAttribute(MARK)).toBe(false);
    act(() => a.focus());
    expect(a.hasAttribute(MARK)).toBe(false);
  });

  it("never marks <html>: the root holds the modality for script alone", () => {
    const { a } = setup();
    act(() => a.focus());
    fireEvent.pointerDown(document);
    expect(document.documentElement.dataset.inputModality).toBe("pointer");
    expect(document.documentElement.hasAttribute(MARK)).toBe(false);
  });

  it("drops the mark when focus leaves", () => {
    const { a } = setup();
    act(() => a.focus());
    fireEvent.pointerDown(document);
    expect(a.hasAttribute(MARK)).toBe(true);
    act(() => a.blur());
    expect(a.hasAttribute(MARK)).toBe(false);
  });

  it("tracks another document on its own (a picture-in-picture window)", () => {
    const other = document.implementation.createHTMLDocument("pip");
    const button = other.createElement("button");
    other.body.append(button);
    const untrack = trackInputModality(other);
    try {
      button.focus();
      other.dispatchEvent(new Event("pointerdown"));
      expect(other.documentElement.dataset.inputModality).toBe("pointer");
      expect(document.documentElement.dataset.inputModality).toBeUndefined();
    } finally {
      untrack();
    }
    expect(other.documentElement.dataset.inputModality).toBeUndefined();
  });
});
