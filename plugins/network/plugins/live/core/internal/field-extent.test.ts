import { describe, expect, test } from "bun:test";
import { extentOf } from "./field-extent";

describe("extentOf", () => {
  test("the min and max of the finite numbers, ignoring everything else", () => {
    expect(extentOf([3, null, 12, "7", NaN, Infinity, -2, undefined])).toEqual({
      min: -2,
      max: 12,
    });
    expect(extentOf([5])).toEqual({ min: 5, max: 5 });
  });

  test("no finite number: null", () => {
    expect(extentOf([])).toBeNull();
    expect(extentOf([null, "x", NaN])).toBeNull();
  });
});
