import type { AppUsageSummaryRow } from "@plugins/apps-core/plugins/app-usage/core";

const DAY_MS = 86_400_000;
/** Days over which a last opening's glow halves. */
const RECENCY_HALF_LIFE_DAYS = 2;
/** Launches in 7 days that make an app as busy as it gets. */
const BUSY_LAUNCHES = 12;
/** Focused time in 7 days that makes an app as busy as it gets. */
const BUSY_FOCUSED_MS = 3 * 3_600_000;

/**
 * How lived-in one app is, 0 … 1: the larger of how recently it was opened
 * (1 just now, halving every {@link RECENCY_HALF_LIFE_DAYS} days) and how much
 * it was used in the last 7 days (launches and focused time). Never opened: 0.
 */
export function lifeOfUsage(row: AppUsageSummaryRow, now: Date): number {
  const recency = row.lastOpenedAt
    ? Math.pow(
        0.5,
        Math.max(0, now.getTime() - row.lastOpenedAt.getTime()) /
          DAY_MS /
          RECENCY_HALF_LIFE_DAYS,
      )
    : 0;
  const busy = Math.min(
    1,
    Math.max(row.launches7d / BUSY_LAUNCHES, row.focusedMs7d / BUSY_FOCUSED_MS),
  );
  return Math.max(0, Math.min(1, Math.max(recency, busy)));
}

/** Every used app's life (an app absent from the summary was never used: 0, and left out). */
export function lifeOfSummary(
  rows: readonly AppUsageSummaryRow[],
  now: Date,
): ReadonlyMap<string, number> {
  return new Map(rows.map((r) => [r.appId, lifeOfUsage(r, now)]));
}
