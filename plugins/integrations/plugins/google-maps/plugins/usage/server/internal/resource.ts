import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { getConfig } from "@plugins/config_v2/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  billingMonth,
  mapsMonthUsage,
  mapsUsageConfig,
  withinBudget,
  type MapsMonthUsage,
} from "../../core";
import { _googleMapsUsage } from "./tables";

/** This billing month's Places calls per SKU, read now. */
async function loadMonthUsage(): Promise<MapsMonthUsage> {
  const { key, resetsAt } = billingMonth(new Date());
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

// Push over `google_maps_usage`: every counted call recomputes this month's
// counts (the declared `reads`). Calls come in bursts (a search and its
// details), hence the throttle.
export const mapsMonthUsageServed = serveValue(mapsMonthUsage, {
  source: "db",
  reads: {
    tables: [_googleMapsUsage],
    reason: "the value is this month's rows of the table, one per SKU",
  },
  throttleMs: 1000,
  loader: loadMonthUsage,
});

/**
 * Whether one more call of a SKU stays within this month's budget, as of now
 * — the server's own reading of the counts and the configured budgets, for a
 * caller with no live value to hold (an agent's tool). The browser's twin is
 * `useMapsBudget`.
 */
export async function mapsBudgetNow(): Promise<(sku: PlacesSku) => boolean> {
  const usage = await loadMonthUsage();
  const budgets = getConfig(mapsUsageConfig);
  const now = new Date();
  return (sku) => withinBudget(usage, budgets, sku, now);
}
