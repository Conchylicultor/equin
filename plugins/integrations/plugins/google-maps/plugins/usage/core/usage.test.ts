import { expect, test } from "bun:test";
import {
  withinBudget,
  type MapsMonthUsage,
  type MapsUsageBudgets,
} from "./usage";
import { mapsUsageConfig } from "./config";

const budgets: MapsUsageBudgets = mapsUsageConfig.defaults;
const usage: MapsMonthUsage = {
  month: "2026-10",
  resetsAt: "2026-11-01T07:00:00.000Z",
  calls: { "text-search-enterprise": 950, "text-search-pro": 10 },
};
const october = new Date("2026-10-20T12:00:00Z");

test("a SKU is within budget until its count reaches it", () => {
  expect(withinBudget(usage, budgets, "text-search-enterprise", october)).toBe(
    false,
  );
  expect(withinBudget(usage, budgets, "text-search-pro", october)).toBe(true);
});

test("IDs-only SKUs have no cap; a new month counts from zero", () => {
  expect(withinBudget(usage, budgets, "text-search-ids", october)).toBe(true);
  expect(
    withinBudget(
      usage,
      budgets,
      "text-search-enterprise",
      new Date("2026-11-01T08:00:00Z"),
    ),
  ).toBe(true);
});
