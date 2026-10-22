import { useMemo } from "react";
import { useConfigResult } from "@plugins/config_v2/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { PlacesSku } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  mapsMonthUsage,
  mapsUsageConfig,
  withinBudget,
  type MapsBudget,
} from "../../core";

/**
 * This month's live Places counts held against the configured budgets —
 * loading until both are known (a budget read as "spent" before the counts
 * land would downgrade for nothing).
 */
export function useMapsBudget(): ResourceResult<MapsBudget> {
  const both = useCombinedResources({
    usage: useLive(mapsMonthUsage),
    budgets: useConfigResult(mapsUsageConfig),
  });
  return useMemo(
    () =>
      mapResource(both, ({ usage, budgets }) => ({
        withinBudget: (sku: PlacesSku) =>
          withinBudget(usage, budgets, sku, new Date()),
        resetsAt: usage.resetsAt,
      })),
    [both],
  );
}
