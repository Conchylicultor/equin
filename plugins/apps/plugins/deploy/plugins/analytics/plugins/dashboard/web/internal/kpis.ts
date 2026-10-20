import {
  averageVisitDurationMs,
  bounceRate,
  viewsPerVisit,
  type Metrics,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { formatCount, formatDurationMs, formatPercent } from "./format";

/**
 * The KPI tiles, as data: each derives its value from additive metrics, so the
 * same definition gives the tile (the period summary) and the chart (every
 * series bucket).
 */
export interface Kpi {
  id: KpiId;
  label: string;
  value: (m: Metrics) => number | null;
  format: (v: number) => string;
  /** Lower is better (bounce rate): a fall reads as good. */
  lowerIsBetter?: true;
  /**
   * Parts that add up to `value`, drawn stacked in the chart in this order
   * (first at the bottom). A part is `null` when the report does not count it
   * (a site whose release predates it); the chart then draws the plain line.
   */
  stack?: readonly KpiPart[];
}

export interface KpiPart {
  id: string;
  label: string;
  value: (m: Metrics) => number | null;
  /** A theme chart token, e.g. `var(--chart-1)`. */
  color: string;
}

export type KpiId =
  | "visitors"
  | "visits"
  | "pageviews"
  | "viewsPerVisit"
  | "bounceRate"
  | "duration";

export const KPIS: readonly Kpi[] = [
  {
    id: "visitors",
    label: "Unique visitors",
    value: (m) => m.visitors,
    format: formatCount,
  },
  {
    id: "visits",
    label: "Visits",
    value: (m) => m.visits,
    format: formatCount,
    stack: [
      {
        id: "new",
        label: "New visits",
        value: (m) =>
          m.returningVisits === null ? null : m.visits - m.returningVisits,
        color: "var(--chart-1)",
      },
      {
        id: "returning",
        label: "Returning visits",
        value: (m) => m.returningVisits,
        color: "var(--chart-3)",
      },
    ],
  },
  {
    id: "pageviews",
    label: "Pageviews",
    value: (m) => m.pageviews,
    format: formatCount,
  },
  {
    id: "viewsPerVisit",
    label: "Views per visit",
    value: viewsPerVisit,
    format: (v) => v.toFixed(2),
  },
  {
    id: "bounceRate",
    label: "Bounce rate",
    value: bounceRate,
    format: formatPercent,
    lowerIsBetter: true,
  },
  {
    id: "duration",
    label: "Visit duration",
    value: averageVisitDurationMs,
    format: formatDurationMs,
  },
];

export function kpiById(id: KpiId): Kpi {
  return KPIS.find((k) => k.id === id)!;
}

/**
 * The change from the previous period. `null` when there is nothing to compare
 * against (no previous value, or it was zero — a change from nothing has no
 * percentage).
 */
export type KpiChange =
  { kind: "flat" } | { kind: "change"; fraction: number; good: boolean };

export function kpiChange(
  kpi: Kpi,
  current: Metrics,
  previous: Metrics,
): KpiChange | null {
  const cur = kpi.value(current);
  const prev = kpi.value(previous);
  if (cur === null || prev === null || prev === 0) return null;
  const fraction = (cur - prev) / prev;
  if (Math.abs(fraction) < 0.005) return { kind: "flat" };
  return {
    kind: "change",
    fraction,
    good: kpi.lowerIsBetter ? fraction < 0 : fraction > 0,
  };
}
