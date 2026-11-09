import { describe, expect, test } from "bun:test";
import { arcStartClearing, logoPath } from "./geometry";

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

describe("arcStartClearing", () => {
  test("the attention dot's knockout trims the arc to start past it", () => {
    const start = arcStartClearing("small", { cx: 84, cy: 16, r: 22 });
    expect(start).toBeCloseTo(-11.6, 1);
    expect(logoPath("small", start)).toStartWith(
      "M87.22 42.36 A38 38 0 1 1 12 50",
    );
  });
  test("a knockout off the arc is an error, not a full arc", () => {
    expect(() => arcStartClearing("small", { cx: 50, cy: 50, r: 5 })).toThrow(
      "does not cross",
    );
  });
});
