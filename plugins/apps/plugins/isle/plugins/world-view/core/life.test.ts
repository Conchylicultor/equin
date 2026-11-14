import { describe, expect, test } from "bun:test";
import type { AppUsageSummaryRow } from "@plugins/apps-core/plugins/app-usage/core";
import { lifeOfSummary, lifeOfUsage } from "./life";

const now = new Date("2026-11-14T12:00:00Z");
const row = (o: Partial<AppUsageSummaryRow>): AppUsageSummaryRow => ({
  appId: "a",
  launches7d: 0,
  focusedMs7d: 0,
  launchesTotal: 0,
  focusedMsTotal: 0,
  lastOpenedAt: null,
  ...o,
});
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe("lifeOfUsage", () => {
  test("never opened is quiet", () => {
    expect(lifeOfUsage(row({}), now)).toBe(0);
  });

  test("opened just now is fully alive", () => {
    expect(lifeOfUsage(row({ lastOpenedAt: now, launches7d: 1 }), now)).toBe(1);
  });

  test("recency halves every two days", () => {
    expect(lifeOfUsage(row({ lastOpenedAt: daysAgo(2) }), now)).toBeCloseTo(
      0.5,
    );
    expect(lifeOfUsage(row({ lastOpenedAt: daysAgo(4) }), now)).toBeCloseTo(
      0.25,
    );
  });

  test("busy apps stay lively even when last opened a while ago", () => {
    expect(
      lifeOfUsage(row({ lastOpenedAt: daysAgo(6), launches7d: 12 }), now),
    ).toBe(1);
    expect(
      lifeOfUsage(
        row({ lastOpenedAt: daysAgo(6), focusedMs7d: 1.5 * 3_600_000 }),
        now,
      ),
    ).toBeCloseTo(0.5);
  });

  test("a last opening in the future (clock skew) counts as now", () => {
    expect(lifeOfUsage(row({ lastOpenedAt: daysAgo(-1) }), now)).toBe(1);
  });
});

test("lifeOfSummary keys each used app", () => {
  const m = lifeOfSummary(
    [row({ appId: "x", lastOpenedAt: now }), row({ appId: "y" })],
    now,
  );
  expect([...m]).toEqual([
    ["x", 1],
    ["y", 0],
  ]);
});
