import type { AnalyticsReport } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { formatBucket } from "./format";
import type { Kpi, KpiPart } from "./kpis";

export interface ChartPoint {
  label: string;
  current: number | null;
  previous: number | null;
  /** The KPI's stacked parts, by part id. */
  parts: Record<string, number | null>;
}

/**
 * The two periods aligned bucket by bucket: point i of the previous period is
 * drawn under point i of the current one. A bucket whose rate has no
 * denominator is a gap, not a zero.
 */
export function chartPoints(report: AnalyticsReport, kpi: Kpi): ChartPoint[] {
  return report.current.series.map((point, i) => {
    const prev = report.previous?.series[i];
    return {
      label: formatBucket(point.bucket, report.granularity),
      current: kpi.value(point.metrics),
      previous: prev ? kpi.value(prev.metrics) : null,
      parts: Object.fromEntries(
        (kpi.stack ?? []).map((part) => [part.id, part.value(point.metrics)]),
      ),
    };
  });
}

/**
 * The parts to stack, or `null` for the plain line: the KPI has none, or the
 * report does not count one of them in some bucket.
 */
export function stackedParts(
  kpi: Kpi,
  points: readonly ChartPoint[],
): readonly KpiPart[] | null {
  const stack = kpi.stack;
  if (!stack) return null;
  const counted = points.every((p) =>
    stack.every((part) => p.parts[part.id] !== null),
  );
  return counted ? stack : null;
}
