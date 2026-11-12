import type { SiteReportRecord } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";

/**
 * Which of a pulled page's rows to import: those seen after `watermark`,
 * oldest first, at most `max` — and the watermark the import then stands at
 * (the last row taken; unchanged when nothing was). Taking the oldest first
 * keeps the watermark honest: a row past the cap is still after it, so the
 * next pull takes it.
 *
 * What a page cannot show is not imported until it recurs: the page holds the
 * site's most recently seen rows, so with more changed rows than it holds the
 * older ones are past it. A bound, by design — a flood on the site must not
 * become a flood here.
 */
export function planImport(
  rows: readonly SiteReportRecord[],
  watermark: Date | null,
  max: number,
): { take: SiteReportRecord[]; watermark: Date | null } {
  const after = watermark?.getTime() ?? Number.NEGATIVE_INFINITY;
  const fresh = rows
    .map((row) => ({ row, at: Date.parse(row.lastSeenAt) }))
    .filter(({ at }) => Number.isFinite(at) && at > after)
    .sort(
      (a, b) => a.at - b.at || (a.row.fingerprint < b.row.fingerprint ? -1 : 1),
    );
  const taken = withoutCutTie(fresh, max);
  const last = taken.at(-1);
  return {
    take: taken.map(({ row }) => row),
    watermark: last ? new Date(last.at) : watermark,
  };
}

/**
 * The first `max` rows — never cutting through rows that share one instant:
 * the watermark is that instant, so a row of the group left behind would never
 * be after it. A cut tie group is left whole for the next run; a first group
 * larger than `max` is taken whole (its size is bounded by the page).
 */
function withoutCutTie<T extends { at: number }>(
  sorted: readonly T[],
  max: number,
): T[] {
  if (sorted.length <= max) return [...sorted];
  const boundary = sorted[max - 1]!.at;
  if (sorted[max]!.at !== boundary) return sorted.slice(0, max);
  const before = sorted.slice(0, max).filter((r) => r.at !== boundary);
  return before.length > 0 ? before : sorted.filter((r) => r.at === boundary);
}
