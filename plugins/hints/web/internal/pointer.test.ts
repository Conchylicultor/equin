import { describe, expect, it } from "bun:test";
import { pointerCard, pointerEndCallback } from "./pointer";

const noop = () => {};

describe("pointerCard", () => {
  it("is a single Done with no callbacks", () => {
    expect(pointerCard({ body: "Here" })).toEqual({
      back: false,
      primary: { label: "Done", end: "close" },
    });
  });

  it("shows Next, Back and the dots when the caller steps", () => {
    expect(
      pointerCard({
        body: "Here",
        onNext: noop,
        onBack: noop,
        step: { index: 1, total: 3 },
      }),
    ).toEqual({
      steps: { count: 3, index: 1 },
      back: true,
      primary: { label: "Next", end: "next" },
    });
  });
});

describe("pointerEndCallback", () => {
  it("runs onNext on next, onBack on back, nothing on close", () => {
    const onNext = () => {};
    const onBack = () => {};
    const opts = { body: "x", onNext, onBack };
    expect(pointerEndCallback(opts, "next")).toBe(onNext);
    expect(pointerEndCallback(opts, "back")).toBe(onBack);
    expect(pointerEndCallback(opts, "close")).toBeUndefined();
  });
});
