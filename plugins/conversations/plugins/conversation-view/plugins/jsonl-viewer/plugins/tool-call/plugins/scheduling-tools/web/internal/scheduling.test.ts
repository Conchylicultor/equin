import { describe, expect, test } from "bun:test";
import { formatDuration, wakeupSummary } from "./scheduling";

describe("scheduling", () => {
  test("formatDuration", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(1200)).toBe("20m");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3600)).toBe("1h");
  });
  test("wakeupSummary", () => {
    expect(wakeupSummary({ delaySeconds: 1200, reason: "check build" })).toBe(
      "in 20m — check build",
    );
    expect(wakeupSummary({ stop: true })).toBe("stop loop");
    expect(wakeupSummary({})).toBeUndefined();
  });
});
