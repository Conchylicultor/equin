import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchTour,
  endPointer,
  isPointing,
  isTourRunning,
  pointAt,
  runTour,
} from "../internal/engine-store";
import { captionFor } from "../internal/pointer";
import type { AnyTour } from "../internal/tour-machine";

afterEach(() => {
  endPointer();
  if (isTourRunning()) dispatchTour({ type: "end", outcome: "dismissed" });
});

/** A button showing `text` (jsdom has no layout, so `innerText` is set by hand). */
const button = (text = "") => {
  const el = document.createElement("button");
  el.innerText = text;
  return el;
};

describe("pointAt", () => {
  it("fails loudly on a target that resolves to nothing", () => {
    expect(() => pointAt(() => null, { label: "x" })).toThrow(/returned null/);
    expect(isPointing()).toBe(false);
  });

  it("is replaced by a second call, and a stale end leaves the new one up", () => {
    pointAt(() => button(), { label: "a" });
    pointAt(() => button(), { label: "b" });
    // An end for a showing no longer up (ids start at 1): a replaced one's
    // lifetime running out must not take the new one down.
    endPointer(0);
    expect(isPointing()).toBe(true);
    endPointer();
    expect(isPointing()).toBe(false);
  });

  it("captions only an element that shows no text of its own", () => {
    expect(captionFor(button(), { label: "Settings" })).toBe("Settings");
    expect(captionFor(button("  "), { label: "Settings" })).toBe("Settings");
    expect(captionFor(button("Tasks"), { label: "Tasks" })).toBeNull();
  });

  it("is refused while a tour runs, and a tour start closes it", () => {
    const tour = {
      id: "t",
      steps: [{ id: "s", anchor: null, title: "T", body: "B" }],
      initialData: {},
    } as unknown as AnyTour;
    pointAt(() => button(), { label: "a" });
    runTour(tour);
    expect(isPointing()).toBe(false);
    expect(() => pointAt(() => button(), { label: "b" })).toThrow(
      /tour is running/,
    );
  });
});
