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
test("a SKU is within budget until its count reaches it", () => {
  expect(withinBudget(usage, budgets, "text-search-enterprise")).toBe(false);
  expect(withinBudget(usage, budgets, "text-search-pro")).toBe(true);
});

test("IDs-only SKUs have no cap", () => {
  expect(withinBudget(usage, budgets, "text-search-ids")).toBe(true);
});
