import { describe, expect, test } from "bun:test";
import { avgPerConversation, costTotals, cumulativeCost } from "./derive";
import type { CostDay, CostSessionDay } from "./values";

function day(date: string, cost: number, tokens = 0): CostDay {
  return {
    date,
    byModel: {},
    cost,
    input: tokens,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  };
}

describe("cumulativeCost", () => {
  test("a running sum, rounded once per point (not a sum of rounded days)", () => {
    expect(
      cumulativeCost([day("2026-10-01", 0.004), day("2026-10-02", 0.004)]),
    ).toEqual([
      { date: "2026-10-01", cost: 0 },
      { date: "2026-10-02", cost: 0.01 },
    ]);
  });
});

describe("costTotals", () => {
  test("totals, active days, the average per active day and the last 7 days from now", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const t = costTotals(
      [
        day("2026-10-01", 10, 100),
        day("2026-10-15", 2, 10),
        day("2026-10-21", 1.005, 1),
      ],
      now,
    );
    expect(t).toEqual({
      totalCost: 13.01,
      totalTokens: 111,
      byTokenKind: { input: 111, output: 0, cacheCreation: 0, cacheRead: 0 },
      // From 2026-10-15 (seven UTC days back) inclusive.
      last7Cost: 3.01,
      avgDailyCost: 4.34,
      activeDays: 3,
    });
  });

  test("no days → zeros, never a division by zero", () => {
    expect(costTotals([], new Date("2026-10-22T00:00:00Z")).avgDailyCost).toBe(
      0,
    );
  });
});

describe("avgPerConversation", () => {
  const sessionDay = (
    date: string,
    sessionCount: number,
    totalCost: number,
    byFamily: CostSessionDay["byFamily"] = {},
  ): CostSessionDay => ({
    date,
    sessionCount,
    totalCost,
    totalTokens: sessionCount * 100,
    byFamily,
  });

  test("averages per day and a 7-day window weighted by session count", () => {
    const points = avgPerConversation(
      [
        sessionDay("2026-10-01", 1, 10, {
          opus: { sessions: 1, cost: 10, tokens: 100 },
        }),
        sessionDay("2026-10-02", 3, 3),
      ],
      ["opus"],
    );
    expect(points.map((p) => [p.avgCost, p.rolling7Cost])).toEqual([
      [10, 10],
      // (10 + 3) / (1 + 3), not the average of 10 and 1.
      [1, 3.25],
    ]);
    expect(points[1]!.byFamily["opus"]).toEqual({ avgCost: 0, avgTokens: 0 });
    expect(points[1]!.rolling7ByFamily["opus"]).toEqual({
      cost: 2.5,
      tokens: 25,
    });
  });

  test("the window is the last seven ACTIVE days", () => {
    const days = Array.from({ length: 8 }, (_, i) =>
      sessionDay(`2026-10-0${i + 1}`, 1, i === 0 ? 80 : 1),
    );
    expect(avgPerConversation(days, []).at(-1)!.rolling7Cost).toBe(1);
  });
});
