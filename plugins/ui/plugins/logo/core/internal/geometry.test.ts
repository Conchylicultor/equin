import { describe, expect, test } from "bun:test";
import { assertDotClear, logoPath } from "./geometry";

describe("logoPath", () => {
  test("full master: ¾ arc, lift, three bowls", () => {
    expect(logoPath("full")).toBe(
      "M50 12 A38 38 0 1 1 12 50 L12 46 A29 29 0 0 0 70 46 A20 20 0 0 1 30 46 A11 11 0 0 0 52 46",
    );
  });
  test("small master: two bowls", () => {
    expect(logoPath("small")).toBe(
      "M50 12 A38 38 0 1 1 12 50 L12 46 A27 27 0 0 0 66 46 A16 16 0 0 1 34 46",
    );
  });
  test("a start past the top is a short arc when it spans 180° or less", () => {
    expect(logoPath("small", 0)).toStartWith("M88 50 A38 38 0 0 1 12 50");
  });
});

describe("assertDotClear", () => {
  test("a dot in the open top-left quarter is clear", () => {
    expect(() =>
      assertDotClear("small", { cx: 18, cy: 18, r: 10 }, 6),
    ).not.toThrow();
  });
  test("a dot over the arc is an error, not a cut logo", () => {
    expect(() => assertDotClear("small", { cx: 84, cy: 16, r: 14 }, 0)).toThrow(
      "comes within",
    );
  });
});
