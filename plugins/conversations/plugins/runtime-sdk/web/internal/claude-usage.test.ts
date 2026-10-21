import { describe, expect, test } from "bun:test";
import { formatResetsIn } from "./claude-usage";

const NOW = 1_800_000_000_000;

describe("formatResetsIn", () => {
  test("hours and minutes, rounded up", () => {
    expect(formatResetsIn(NOW + 108 * 60_000, NOW)).toBe("in 1 h 48 m");
    expect(formatResetsIn(NOW + 120 * 60_000, NOW)).toBe("in 2 h");
    expect(formatResetsIn(NOW + 30_000, NOW)).toBe("in 1 m");
  });
});
