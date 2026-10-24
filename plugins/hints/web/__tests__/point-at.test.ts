import { afterEach, describe, expect, it, vi } from "vitest";
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
  endPointer("close");
  if (isTourRunning()) dispatchTour({ type: "end", outcome: "dismissed" });
});

const button = () => document.createElement("button");

describe("pointAt", () => {
  it("fails loudly on a target that resolves to nothing", () => {
    expect(() => pointAt(() => null, { body: "x" })).toThrow(/returned null/);
    expect(isPointing()).toBe(false);
  });

  it("closes before running Next, so the callback may point again", () => {
    const second = button();
    const onNext = vi.fn(() => {
      expect(isPointing()).toBe(false);
      pointAt(() => second, { body: "second" });
    });
    pointAt(button, { body: "first", onNext });
    endPointer("next");
    expect(onNext).toHaveBeenCalledOnce();
    expect(isPointing()).toBe(true);
  });

  it("runs no callback when closed or replaced", () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    pointAt(button, { body: "a", onNext, onBack });
    pointAt(button, { body: "b" });
    endPointer("close");
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
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
