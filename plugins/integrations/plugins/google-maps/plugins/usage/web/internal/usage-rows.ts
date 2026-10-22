import {
  PLACES_SKUS,
  type PlacesSku,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  budgetField,
  mapsUsageConfig,
  monthCalls,
  type MapsMonthUsage,
  type MapsUsageBudgets,
} from "../../core";

/** Where a SKU stands this month: `near` from 80% of its budget, `spent` at it. */
export const USAGE_STATES = ["ok", "near", "spent", "free"] as const;
export type UsageState = (typeof USAGE_STATES)[number];

const NEAR = 0.8;

/** How a free (IDs-only) SKU reads, when it was called this month. */
function freeLabel(sku: PlacesSku): string {
  return sku.startsWith("place-details")
    ? "Place Details IDs only"
    : sku.startsWith("text-search")
      ? "Text Search IDs only"
      : sku;
}

/** One SKU's month, as the usage readout lists it. */
export interface UsageRow {
  sku: PlacesSku;
  label: string;
  /** What the SKU pays for (the budget field's description). */
  description: string | undefined;
  calls: number;
  /** `null`: an IDs-only SKU — free, no cap. */
  budget: number | null;
  state: UsageState;
}

/**
 * Every budgeted SKU (in config order), then every free one that was called
 * this month — counts held against the configured budgets.
 */
export function usageRows(
  usage: MapsMonthUsage,
  budgets: MapsUsageBudgets,
  now: Date,
): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const sku of PLACES_SKUS) {
    const calls = monthCalls(usage, sku, now);
    const field = budgetField(sku);
    if (field === null) {
      if (calls > 0) {
        rows.push({
          sku,
          label: freeLabel(sku),
          description:
            "Free: Google does not bill these calls (photo names, place ids).",
          calls,
          budget: null,
          state: "free",
        });
      }
      continue;
    }
    const budget = budgets[field];
    const meta = mapsUsageConfig.fields[field].meta;
    rows.push({
      sku,
      label: (meta.label ?? field).replace(/ \/ month$/, ""),
      description: meta.description,
      calls,
      budget,
      state: calls >= budget ? "spent" : calls >= budget * NEAR ? "near" : "ok",
    });
  }
  return rows;
}
