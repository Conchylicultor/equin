import { z } from "zod";

/**
 * Report ranges and the periods they cover. All days are UTC calendar days
 * (`YYYY-MM-DD`) — the same day the visitor-hash salt rotates on and the
 * nightly rollup sums.
 */
export const ANALYTICS_RANGES = ["today", "7d", "30d", "12m"] as const;
export const AnalyticsRangeSchema = z.enum(ANALYTICS_RANGES);
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;

export const GRANULARITIES = ["hour", "day", "month"] as const;
export const GranularitySchema = z.enum(GRANULARITIES);
export type Granularity = z.infer<typeof GranularitySchema>;

/**
 * Per-visit rows are kept this many days (the retention sweep deletes visits
 * that started more than 90×24h ago). A period whose every day is at most
 * `RAW_RETENTION_DAYS - 1` days before today is therefore fully present.
 */
export const RAW_RETENTION_DAYS = 90;

/**
 * How long a visitor may stay away and still be recognised as the same
 * visitor. The salts (and the hash → visitor links) of the last this-many days
 * are kept; older ones are deleted by the nightly rollup, after which a
 * visitor absent that long can no longer be linked to anything.
 */
export const IDENTITY_WINDOW_DAYS = 30;

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const DaySchema = z.string().regex(DAY_PATTERN);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of an instant. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** `day` shifted by `n` whole days (negative goes back). */
export function addDays(day: string, n: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

/** The first day of `day`'s month, shifted by `n` months. */
export function addMonths(day: string, n: number): string {
  const [year, month] = day.split("-").map(Number) as [number, number];
  return utcDay(new Date(Date.UTC(year, month - 1 + n, 1)));
}

/** A series bucket key: `YYYY-MM-DDTHH:00:00Z` for hours, `YYYY-MM-DD` for days, the month's first day for months. */
export function bucketOf(granularity: Granularity, instant: Date): string {
  const day = utcDay(instant);
  switch (granularity) {
    case "hour":
      return `${day}T${String(instant.getUTCHours()).padStart(2, "0")}:00:00Z`;
    case "day":
      return day;
    case "month":
      return addMonths(day, 0);
  }
}

/** One side of a comparison: inclusive UTC days, and every series bucket in order. */
export interface ReportPeriod {
  from: string;
  to: string;
  granularity: Granularity;
  buckets: string[];
}

/**
 * The most series buckets one period has: `30d`'s 30 days (`today` has 24
 * hours, `7d` 7 days, `12m` 12 months). The report schema caps a series at it.
 */
export const MAX_SERIES_BUCKETS = 30;

function dayBuckets(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

function hourBuckets(day: string): string[] {
  return Array.from(
    { length: 24 },
    (_, h) => `${day}T${String(h).padStart(2, "0")}:00:00Z`,
  );
}

function monthBuckets(firstMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(firstMonth, i));
}

/**
 * The current period of `range` as of `now`, and the equally long period right
 * before it (what `compare` draws as the dashed line).
 *
 * - `today`: today, hourly; previous = yesterday.
 * - `7d` / `30d`: the last 7 / 30 days including today, daily.
 * - `12m`: the last 12 months including the current one, monthly; previous =
 *   the 12 months before.
 */
export function planPeriods(
  range: AnalyticsRange,
  now: Date,
): { current: ReportPeriod; previous: ReportPeriod } {
  const today = utcDay(now);
  switch (range) {
    case "today": {
      const yesterday = addDays(today, -1);
      return {
        current: {
          from: today,
          to: today,
          granularity: "hour",
          buckets: hourBuckets(today),
        },
        previous: {
          from: yesterday,
          to: yesterday,
          granularity: "hour",
          buckets: hourBuckets(yesterday),
        },
      };
    }
    case "7d":
    case "30d": {
      const days = range === "7d" ? 7 : 30;
      const from = addDays(today, -(days - 1));
      const prevFrom = addDays(from, -days);
      return {
        current: {
          from,
          to: today,
          granularity: "day",
          buckets: dayBuckets(from, days),
        },
        previous: {
          from: prevFrom,
          to: addDays(from, -1),
          granularity: "day",
          buckets: dayBuckets(prevFrom, days),
        },
      };
    }
    case "12m": {
      const from = addMonths(today, -11);
      const prevFrom = addMonths(today, -23);
      return {
        current: {
          from,
          to: today,
          granularity: "month",
          buckets: monthBuckets(from, 12),
        },
        previous: {
          from: prevFrom,
          to: addDays(from, -1),
          granularity: "month",
          buckets: monthBuckets(prevFrom, 12),
        },
      };
    }
  }
}

/** The oldest day whose per-visit rows are all still present. */
export function firstRawDay(now: Date): string {
  return addDays(utcDay(now), -(RAW_RETENTION_DAYS - 1));
}
