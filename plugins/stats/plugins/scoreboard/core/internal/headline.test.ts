import { describe, expect, test } from "bun:test";
import { scoreboardHeadline, trendOf, weekOf } from "./headline";
import type { Scoreboard, ScoreboardSeries } from "./value";

const stat = (p95Ms: number | null, count = 10) => ({
  count: p95Ms === null ? 0 : count,
  p50Ms: p95Ms,
  p95Ms,
});

function series(
  metric: ScoreboardSeries["metric"],
  audience: ScoreboardSeries["audience"],
  prev: number | null,
  last: number | null,
): ScoreboardSeries {
  return {
    metric,
    audience,
    days: [],
    weeks: [],
    prev7: stat(prev),
    last7: stat(last),
  };
}

const base: Scoreboard = {
  sinceDay: "2026-10-15",
  days: [],
  weeks: [],
  latency: [],
  kinds: [],
  fixKinds: [],
  reportsKnownFrom: null,
  convergenceKnownFrom: null,
  restartsKnownFrom: null,
};

describe("weekOf", () => {
  test("a day maps to its Monday", () => {
    expect(weekOf("2026-11-19")).toBe("2026-11-16"); // Thursday
    expect(weekOf("2026-11-16")).toBe("2026-11-16"); // Monday
    expect(weekOf("2026-11-22")).toBe("2026-11-16"); // Sunday
  });
});

describe("trendOf", () => {
  test("lower is better, within 10% is flat, missing is unknown", () => {
    expect(trendOf(100, 80)).toBe("better");
    expect(trendOf(100, 120)).toBe("worse");
    expect(trendOf(100, 105)).toBe("flat");
    expect(trendOf(null, 5)).toBe("unknown");
  });
});

describe("scoreboardHeadline", () => {
  test("no data says so", () => {
    expect(scoreboardHeadline(base)).toStartWith("Not enough data yet");
  });

  test("real tabs win over every-tab rows once both weeks have them", () => {
    const sb: Scoreboard = {
      ...base,
      latency: [
        series("navigate", "all", 1000, 3000),
        series("navigate", "real", 1000, 500),
      ],
    };
    const line = scoreboardHeadline(sb);
    expect(line).toStartWith("Getting faster");
    expect(line).toContain("navigation 1.0 s → 500 ms");
  });

  test("falls back to every tab when real tabs have no history yet", () => {
    const sb: Scoreboard = {
      ...base,
      latency: [
        series("update-e2e", "real", null, 50),
        series("update-e2e", "all", 100, 300),
      ],
    };
    expect(scoreboardHeadline(sb)).toStartWith("Getting slower");
  });
});
