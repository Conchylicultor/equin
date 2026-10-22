import type { TaskHistoryDay } from "./values";

/** A point of the cumulative chart: the running totals at the end of `date`. */
export interface CumulativePoint {
  date: string;
  total: number;
  active: number;
  completed: number;
  dropped: number;
}

/** A point of the velocity chart: `net` > 0 = more resolved than added that day. */
export interface VelocityPoint extends TaskHistoryDay {
  net: number;
}

/** Running totals over the days (ascending): active = total − completed − dropped. */
export function cumulativeSeries(
  days: readonly TaskHistoryDay[],
): CumulativePoint[] {
  let total = 0;
  let completed = 0;
  let dropped = 0;
  return days.map((d) => {
    total += d.added;
    completed += d.completed;
    dropped += d.dropped;
    return {
      date: d.date,
      total,
      active: total - completed - dropped,
      completed,
      dropped,
    };
  });
}

/** Each day with its net (resolved − added) — the negative of Δactive. */
export function velocitySeries(
  days: readonly TaskHistoryDay[],
): VelocityPoint[] {
  return days.map((d) => ({ ...d, net: d.completed + d.dropped - d.added }));
}
