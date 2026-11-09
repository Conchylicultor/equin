import { describe, expect, test } from "bun:test";
import { arrivalDelayMs } from "./arrival-timing";

describe("arrivalDelayMs", () => {
  test("a short batch cascades 150 ms apart from its mount", () => {
    expect([0, 1, 2, 3].map((s) => arrivalDelayMs(s, 4))).toEqual([
      0, 150, 300, 450,
    ]);
  });

  test("one step arrives at once", () => {
    expect(arrivalDelayMs(0, 1)).toBe(0);
  });

  test("a long batch compresses its gaps to keep the cascade within 900 ms", () => {
    expect(arrivalDelayMs(19, 20)).toBe(900);
    expect(arrivalDelayMs(99, 100)).toBe(900);
  });
});
