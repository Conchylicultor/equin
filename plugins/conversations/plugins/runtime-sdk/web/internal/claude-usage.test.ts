import { describe, expect, test } from "bun:test";
import { formatResetsIn, viewUsageWindow } from "./claude-usage";

const NOW = 1_800_000_000_000;

describe("viewUsageWindow", () => {
  test("current, with its level", () => {
    expect(
      viewUsageWindow({ utilization: 0.5, resetsAt: NOW + 1 }, NOW),
    ).toEqual({
      kind: "current",
      utilization: 0.5,
      level: "ok",
      resetsAt: NOW + 1,
    });
    expect(
      viewUsageWindow({ utilization: 0.8, resetsAt: NOW + 1 }, NOW),
    ).toMatchObject({ level: "high" });
    expect(
      viewUsageWindow({ utilization: 1, resetsAt: NOW + 1 }, NOW),
    ).toMatchObject({ level: "full" });
  });

  test("reset since the reading: not known", () => {
    expect(viewUsageWindow({ utilization: 1, resetsAt: NOW }, NOW)).toEqual({
      kind: "reset",
      resetAt: NOW,
    });
  });
});

describe("formatResetsIn", () => {
  test("hours and minutes, rounded up", () => {
    expect(formatResetsIn(NOW + 108 * 60_000, NOW)).toBe("in 1 h 48 m");
    expect(formatResetsIn(NOW + 120 * 60_000, NOW)).toBe("in 2 h");
    expect(formatResetsIn(NOW + 30_000, NOW)).toBe("in 1 m");
  });
});
