import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { getConfig } from "@plugins/config_v2/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  billingMonth,
  billingMonthOf,
  mapsMonthUsage,
  mapsUsageConfig,
  withinBudget,
  type MapsBudget,
  type MapsMonthUsage,
} from "../../core";
import { _googleMapsUsage } from "./tables";

/** One billing month's Places calls per SKU (its `YYYY-MM` key). */
async function loadMonthUsage(month: string): Promise<MapsMonthUsage> {
  const { key, resetsAt } = billingMonthOf(month);
  const rows = await db
    .select({ sku: _googleMapsUsage.sku, calls: _googleMapsUsage.calls })
    .from(_googleMapsUsage)
    .where(eq(_googleMapsUsage.month, key));
  return {
    month: key,
    resetsAt: resetsAt.toISOString(),
    calls: Object.fromEntries(rows.map((r) => [r.sku, r.calls])),
  };
}

// Push over `google_maps_usage`: every counted call recomputes the month's
// counts (the declared `reads`). The month is the reader's pinned param, never
// the clock: it re-pins at the turn of the month. Calls come in bursts (a
// search and its details), hence the throttle.
export const mapsMonthUsageServed = serveValue(mapsMonthUsage, {
  source: "db",
  reads: {
    tables: [_googleMapsUsage],
    reason: "the value is this month's rows of the table, one per SKU",
  },
  throttleMs: 1000,
  loader: ({ month }) => loadMonthUsage(month),
});

/**
 * The Postgres reads a served value declares when its loader asks
 * `mapsBudgetNow` (`reads` on a `changes: "notified"` external value): every
 * counted call recomputes it, so an open reader steps down the moment a
 * budget is spent. The table stays this plugin's to name.
 */
export const mapsBudgetReads = {
  tables: [_googleMapsUsage],
  reason:
    "the loader holds this month's counts against the budgets (mapsBudgetNow) to pick its rung; a counted call may move it down a rung",
};

/**
 * Whether one more call of a SKU stays within a billing month's budget — the
 * server's own reading of the counts and the configured budgets, for a served
 * value whose question pins the month (`MAPS_BILLING_MONTH`, place details).
 */
export async function mapsBudgetFor(month: string): Promise<MapsBudget> {
  const usage = await loadMonthUsage(month);
  const budgets = getConfig(mapsUsageConfig);
  return {
    withinBudget: (sku) => withinBudget(usage, budgets, sku),
    resetsAt: usage.resetsAt,
  };
}

/**
 * The same, for this month as of now — for a caller that is no live read (an
 * agent's tool, a photo request): a point answer, read once. The browser's
 * twin is `useMapsBudget`; a served value pins the month instead
 * (`mapsBudgetFor`).
 */
export async function mapsBudgetNow(): Promise<MapsBudget> {
  return mapsBudgetFor(billingMonth(new Date()).key);
}
