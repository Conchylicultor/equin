import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./format";

describe("formatDuration", () => {
  test.each([
    [0, "0ms"],
    [0.35, "0.4ms"],
    [4, "4ms"],
    [850, "850ms"],
    [999.6, "1.0s"],
    [4200, "4.2s"],
    [59_960, "1m 00s"],
    [64_000, "1m 04s"],
    [3_599_400, "59m 59s"],
    [3_599_600, "1h 00m"],
    [2 * 3_600_000 + 5 * 60_000, "2h 05m"],
    [3 * 86_400_000 + 4 * 3_600_000, "3d 04h"],
    [-4200, "-4.2s"],
  ])("%p ms → %p", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  test("a non-finite span throws", () => {
    expect(() => formatDuration(Number.NaN)).toThrow();
  });
});

describe("parseDuration", () => {
  test.each([
    ["250ms", 250],
    ["30s", 30_000],
    ["5m", 300_000],
    ["5 min", 300_000],
    ["1h", 3_600_000],
    ["1.5h", 5_400_000],
    ["2d", 172_800_000],
    ["1m 30s", 90_000],
    ["1h30m", 5_400_000],
    ["  45 S ", 45_000],
    ["1500", 1500],
    [".5s", 500],
  ])("%p → %p ms", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  test.each(["", "  ", "abc", "5x", "s", "1m30", "-5s", "1..2s"])(
    "%p is not a span",
    (text) => {
      expect(parseDuration(text)).toBeNull();
    },
  );

  test("a formatted span parses back", () => {
    for (const ms of [850, 4200, 64_000, 7_500_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });
});
