// What a job's crontab MEANS, read through graphile's own parser — so a page
// describing a schedule can never disagree with the scheduler about it.
//
// `parseCronRangeString` is graphile's parse of the five time fields (the one
// `parseCronItem` runs, `dist/cronMatcher.js`); the next firing is found by
// asking the INSTALLED item's own `match` — the very function graphile's cron
// loop calls each minute (`dist/cron.js`) — so it reflects what this backend
// actually scheduled, resolver and main-only gating included.
import { parseCronRangeString } from "graphile-worker/dist/cronMatcher";
import type { ParsedCronItem } from "graphile-worker";

/**
 * The five crontab fields as graphile parsed them: each the sorted, unique
 * values that match (minutes 0-59, hours 0-23, dates 1-31, months 1-12, days of
 * week 0-6 with 0 = Sunday). A `*` field holds every value of its range.
 */
export interface CronRanges {
  minutes: number[];
  hours: number[];
  dates: number[];
  months: number[];
  dows: number[];
}

/** Parse a crontab's time fields exactly as graphile does. Throws on a pattern
 * graphile would refuse. */
export function cronRanges(expr: string): CronRanges {
  const parsed = parseCronRangeString(expr, `cron "${expr}"`);
  return {
    minutes: [...parsed.minutes],
    hours: [...parsed.hours],
    dates: [...parsed.dates],
    months: [...parsed.months],
    dows: [...parsed.dows],
  };
}

// How far ahead to look for the next firing. Every schedule in use fires at
// least weekly; one that fires less often reads as "no next run known" rather
// than costing a year of minute-by-minute probes.
const LOOKAHEAD_MINUTES = 8 * 24 * 60;

/**
 * The first minute strictly after `from` at which `item` fires, by graphile's
 * own matcher and its UTC timestamp digest — or `null` when it does not fire
 * within {@link LOOKAHEAD_MINUTES}.
 */
export function nextFiring(item: ParsedCronItem, from: Date): Date | null {
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < LOOKAHEAD_MINUTES; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (
      item.match({
        min: t.getUTCMinutes(),
        hour: t.getUTCHours(),
        date: t.getUTCDate(),
        month: t.getUTCMonth() + 1,
        dow: t.getUTCDay(),
      })
    ) {
      return new Date(t.getTime());
    }
  }
  return null;
}
