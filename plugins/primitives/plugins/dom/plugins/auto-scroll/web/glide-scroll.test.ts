import { describe, expect, it } from "bun:test";
import { cubicBezierAt, type CubicBezier } from "./glide-scroll";

const EASE_OUT: CubicBezier = [0.33, 1, 0.68, 1];

describe("cubicBezierAt", () => {
  it("starts at 0 and lands at 1", () => {
    expect(cubicBezierAt(EASE_OUT, 0)).toBe(0);
    expect(cubicBezierAt(EASE_OUT, 1)).toBe(1);
  });

  it("is the identity for the linear curve", () => {
    for (const x of [0.1, 0.25, 0.5, 0.9]) {
      expect(cubicBezierAt([0, 0, 1, 1], x)).toBeCloseTo(x, 4);
    }
  });

  it("an ease-out is ahead of linear and monotonic", () => {
    let prev = 0;
    for (let i = 1; i < 20; i++) {
      const y = cubicBezierAt(EASE_OUT, i / 20);
      expect(y).toBeGreaterThan(i / 20);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});
