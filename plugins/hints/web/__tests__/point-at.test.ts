import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchTour,
  endPointer,
  isPointing,
  isTourRunning,
  pointAt,
  runTour,
} from "../internal/engine-store";
import type { AnyTour } from "../internal/tour-machine";

afterEach(() => {
  endPointer();
  if (isTourRunning()) dispatchTour({ type: "end", outcome: "dismissed" });
});

const button = () => document.createElement("button");

describe("pointAt", () => {
  it("fails loudly on a target that resolves to nothing", () => {
    expect(() => pointAt(() => null, { body: "x" })).toThrow(/returned null/);
    expect(isPointing()).toBe(false);
  });

  it("is replaced by a second call, and a stale end leaves the new one up", () => {
    pointAt(button, { body: "a" });
    pointAt(button, { body: "b" });
    // An end for a showing no longer up (ids start at 1): a replaced one's
    // lifetime running out must not take the new one down.
    endPointer(0);
    expect(isPointing()).toBe(true);
    endPointer();
    expect(isPointing()).toBe(false);
  });

  it("is refused while a tour runs, and a tour start closes it", () => {
    const tour = {
      id: "t",
      steps: [{ id: "s", anchor: null, title: "T", body: "B" }],
      initialData: {},
    } as unknown as AnyTour;
    pointAt(button, { body: "a" });
    runTour(tour);
    expect(isPointing()).toBe(false);
    expect(() => pointAt(button, { body: "b" })).toThrow(/tour is running/);
  });
});
