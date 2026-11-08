import type { ReportHourly, ReportOccurrence } from "./entity";

const HOUR_MS = 3_600_000;

/** The clock hour an instant falls in (its UTC start, epoch ms) — `hourly`'s bucket key. */
export function reportHourOf(atMs: number): number {
  return Math.floor(atMs / HOUR_MS) * HOUR_MS;
}

/**
 * How many times a report fired recently, beside its lifetime total.
 *
 * `recent` counts the current clock hour and the 23 before it ("the last
 * 24 h", to the hour). `exact` is false only when the report's per-hour count
 * started inside that window and `recent` (the newest occurrences) cannot
 * reach back past it — then `n` is a floor ("at least n"), never a guess.
 */
export interface ReportActivity {
  recent: { n: number; exact: boolean };
  total: number;
}

/** What {@link reportActivity} reads of a report. */
export interface ReportActivityInput {
  count: number;
  lastSeenAt: Date;
  hourly: ReportHourly | null;
  recent: readonly Pick<ReportOccurrence, "at">[];
}

/** {@link ReportActivity} of a report at `nowMs`. */
export function reportActivity(
  r: ReportActivityInput,
  nowMs: number,
): ReportActivity {
  const total = r.count;
  const windowStart = reportHourOf(nowMs) - 23 * HOUR_MS;
  if (r.lastSeenAt.getTime() < windowStart) {
    return { recent: { n: 0, exact: true }, total };
  }
  const hourlyN =
    r.hourly?.hours
      .filter((b) => b.h >= windowStart)
      .reduce((sum, b) => sum + b.n, 0) ?? 0;
  const untrackedBefore =
    r.hourly === null ? Number.POSITIVE_INFINITY : r.hourly.untrackedBefore;
  if (untrackedBefore === null || untrackedBefore <= windowStart) {
    return { recent: { n: hourlyN, exact: true }, total };
  }
  // Counting per hour began inside the window: what came before it is read
  // from `recent`, which is exact when it holds every occurrence or reaches
  // back past the window's start.
  const recentN = r.recent.filter((o) => o.at >= windowStart).length;
  const complete =
    total <= r.recent.length || r.recent.some((o) => o.at < windowStart);
  return complete
    ? { recent: { n: recentN, exact: true }, total }
    : { recent: { n: Math.max(recentN, hourlyN), exact: false }, total };
}

const fmt = new Intl.NumberFormat("en-US");

/** The recent count as a short label: `31`, `≥ 10`. */
export function formatRecentCount(a: ReportActivity): string {
  return `${a.recent.exact ? "" : "≥ "}${fmt.format(a.recent.n)}`;
}

/** The activity in one line: `31 in the last 24 h · 2,717 total`. */
export function formatReportActivity(a: ReportActivity): string {
  return `${formatRecentCount(a)} in the last 24 h · ${fmt.format(a.total)} total`;
}
