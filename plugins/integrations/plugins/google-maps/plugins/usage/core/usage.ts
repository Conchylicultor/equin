import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import type { mapsUsageConfig } from "./config";

/**
 * This billing month's Places calls per SKU (`google_maps_usage`), live: every
 * counted call recomputes it, so a reader steps down the moment a budget is
 * spent. `resetsAt` is when the month starts over — past it, every count is
 * zero whatever this value still says (nothing writes at the turn of a month).
 */
export const MapsMonthUsageSchema = z.object({
  month: z.string(),
  resetsAt: z.string().datetime(),
  calls: z.record(z.string(), z.number().int().nonnegative()),
});
export type MapsMonthUsage = z.infer<typeof MapsMonthUsageSchema>;

export const mapsMonthUsage = liveValue("google-maps.usage", {
  schema: MapsMonthUsageSchema,
});

/** The configured monthly budgets (`mapsUsageConfig`). */
export type MapsUsageBudgets = ConfigValues<(typeof mapsUsageConfig)["fields"]>;

/**
 * Each SKU's budget field, or `null` for Google's IDs-only SKUs (free, no
 * cap). A `Record` over every SKU, so a SKU added to places-api is a type
 * error here until it is given a budget.
 */
const BUDGET_FIELD: Record<PlacesSku, keyof MapsUsageBudgets | null> = {
  autocomplete: "autocomplete",
  "place-details-ids": null,
  "place-details-essentials": "placeDetailsEssentials",
  "place-details-pro": "placeDetailsPro",
  "place-details-enterprise": "placeDetailsEnterprise",
  "place-details-enterprise-atmosphere": "placeDetailsEnterpriseAtmosphere",
  "text-search-ids": null,
  "text-search-pro": "textSearchPro",
  "text-search-enterprise": "textSearchEnterprise",
  "text-search-enterprise-atmosphere": "textSearchEnterpriseAtmosphere",
  "place-photo": "placePhoto",
};

/** This month's Places budget, as a reader asks it (`useMapsBudget` / `mapsBudgetNow`). */
export interface MapsBudget {
  /** Whether one more call of `sku` stays within this month's budget. */
  withinBudget: (sku: PlacesSku) => boolean;
  /** When the month — and every count — starts over (ISO). */
  resetsAt: string;
}

/** `sku`'s budget field, or `null` for an IDs-only SKU (free, no cap). */
export function budgetField(sku: PlacesSku): keyof MapsUsageBudgets | null {
  return BUDGET_FIELD[sku];
}

/** This month's count of `sku` — zero once `resetsAt` has passed. */
export function monthCalls(
  usage: MapsMonthUsage,
  sku: PlacesSku,
  now: Date,
): number {
  return now >= new Date(usage.resetsAt) ? 0 : (usage.calls[sku] ?? 0);
}

/** Whether one more call of `sku` stays within this month's budget. */
export function withinBudget(
  usage: MapsMonthUsage,
  budgets: MapsUsageBudgets,
  sku: PlacesSku,
  now: Date,
): boolean {
  const field = BUDGET_FIELD[sku];
  if (field === null) return true;
  return monthCalls(usage, sku, now) < budgets[field];
}
