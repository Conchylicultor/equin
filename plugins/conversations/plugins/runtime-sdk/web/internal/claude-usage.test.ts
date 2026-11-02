import { describe, expect, test } from "bun:test";
import { formatResetsIn, windowElapsed } from "./claude-usage";

const NOW = 1_800_000_000_000;

describe("formatResetsIn", () => {
  test("hours and minutes, rounded up", () => {
    expect(formatResetsIn(NOW + 108 * 60_000, NOW)).toBe("in 1 h 48 m");
    expect(formatResetsIn(NOW + 120 * 60_000, NOW)).toBe("in 2 h");
    expect(formatResetsIn(NOW + 30_000, NOW)).toBe("in 1 m");
  });
});

describe("windowElapsed", () => {
  const day = 24 * 60 * 60_000;
  test("the share of the week gone by, from its reset", () => {
    expect(windowElapsed("week", 7 * day, 0)).toBe(0);
    expect(windowElapsed("week", 5 * day, 0)).toBeCloseTo(2 / 7);
  });
  test("clamped to the window", () => {
    expect(windowElapsed("week", 8 * day, 0)).toBe(0);
    expect(windowElapsed("week", 0, day)).toBe(1);
  });
});
