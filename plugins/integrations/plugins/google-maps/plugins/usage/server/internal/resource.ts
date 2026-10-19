import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { billingMonth, mapsMonthUsage } from "../../core";
import { _googleMapsUsage } from "./tables";

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
  loader: async () => {
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
  },
});
