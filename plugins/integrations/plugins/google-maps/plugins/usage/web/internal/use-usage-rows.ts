import { useMemo } from "react";
import { useConfigResult } from "@plugins/config_v2/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { IntegrationStatus } from "@plugins/auth/web";
import { mapsMonthUsage, mapsUsageConfig } from "../../core";
import { usageRows, type UsageRow } from "./usage-rows";

export interface MapsUsageReadout {
  rows: UsageRow[];
  /** When the month — and every count — starts over (ISO). */
  resetsAt: string;
}

/** This month's live counts as readout rows, against the configured budgets. */
export function useUsageReadout(): ResourceResult<MapsUsageReadout> {
  const both = useCombinedResources({
    usage: useLive(mapsMonthUsage),
    budgets: useConfigResult(mapsUsageConfig),
  });
  return useMemo(
    () =>
      mapResource(both, ({ usage, budgets }) => ({
        rows: usageRows(usage, budgets, new Date()),
        resetsAt: usage.resetsAt,
      })),
    [both],
  );
}

/** The usage row's Accounts badge: within budget, or how many calls are downgraded. */
export function useUsageStatus(): ResourceResult<IntegrationStatus> {
  return mapResource(useUsageReadout(), ({ rows }) => {
    const spent = rows.filter((r) => r.state === "spent").length;
    if (spent > 0) {
      return {
        tone: "warning",
        label: `${spent} downgraded`,
        summary: "Some calls step down until the month resets",
      };
    }
    return rows.some((r) => r.state === "near")
      ? { tone: "warning", label: "Near budget" }
      : { tone: "success", label: "Within budget" };
  });
}
