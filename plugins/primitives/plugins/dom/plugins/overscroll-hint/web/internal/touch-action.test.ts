import { describe, expect, test } from "bun:test";
import { touchActionAllows } from "./touch-action";

describe("touchActionAllows", () => {
  test("auto and manipulation pan both ways", () => {
    for (const v of ["auto", "manipulation"]) {
      expect(touchActionAllows(v, "x")).toBe(true);
      expect(touchActionAllows(v, "y")).toBe(true);
    }
  });
  test("none pans neither way", () => {
    expect(touchActionAllows("none", "x")).toBe(false);
    expect(touchActionAllows("none", "y")).toBe(false);
  });
  test("pinch-zoom alone pans neither way", () => {
    expect(touchActionAllows("pinch-zoom", "x")).toBe(false);
    expect(touchActionAllows("pinch-zoom", "y")).toBe(false);
  });
  test("a pan value allows its own axis only", () => {
    expect(touchActionAllows("pan-y", "y")).toBe(true);
    expect(touchActionAllows("pan-y", "x")).toBe(false);
    expect(touchActionAllows("pan-left pinch-zoom", "x")).toBe(true);
    expect(touchActionAllows("pan-left pinch-zoom", "y")).toBe(false);
    expect(touchActionAllows("pan-x pan-down", "y")).toBe(true);
  });
});
