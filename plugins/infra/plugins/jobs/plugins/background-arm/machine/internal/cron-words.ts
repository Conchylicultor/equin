import type { CronRanges } from "@plugins/infra/plugins/jobs/machine";

// A crontab in plain language, from graphile's parse of it (never from the
// string) — so "Mondays 03:40 UTC" is what the scheduler will actually do. The
// shapes phrased are the ones schedules use; anything else reads as its
// expression, which is never wrong, only less friendly.

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const FULL = {
  minutes: 60,
  hours: 24,
  dates: 31,
  months: 12,
  dows: 7,
} as const;

function isFull(ranges: CronRanges, field: keyof typeof FULL): boolean {
  return ranges[field].length === FULL[field];
}

/** `n` when `values` is exactly 0, n, 2n, … covering a range of `size` that n
 * divides evenly (`*\/15` of minutes); otherwise `null`. */
function evenStep(values: readonly number[], size: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1]!;
  if (size % step !== 0 || values.length !== size / step) return null;
  return values.every((v, i) => v === i * step) ? step : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

function times(hours: readonly number[], minute: number): string {
  return hours.map((h) => `${pad(h)}:${pad(minute)}`).join(", ");
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function days(dows: readonly number[]): string {
  if (dows.length === 5 && dows.every((d, i) => d === i + 1)) return "Weekdays";
  if (dows.length === 1) return `${DAY_NAMES[dows[0]!]}s`;
  return dows.map((d) => DAY_NAMES[d]!.slice(0, 3)).join(", ");
}

/**
 * Describe a parsed crontab, or return `expr` itself for a shape this does not
 * phrase. Times are UTC, as graphile schedules them.
 */
export function cronWords(ranges: CronRanges, expr: string): string {
  const allDates = isFull(ranges, "dates");
  const allMonths = isFull(ranges, "months");
  const allDows = isFull(ranges, "dows");
  if (!allMonths) return expr;

  const everyDay = allDates && allDows;
  const { minutes, hours } = ranges;

  if (everyDay && isFull(ranges, "hours")) {
    if (isFull(ranges, "minutes")) return "Every minute";
    const step = evenStep(minutes, FULL.minutes);
    if (step !== null) return `Every ${step} minutes`;
    if (minutes.length === 1) {
      return minutes[0] === 0 ? "Hourly" : `Hourly at :${pad(minutes[0]!)}`;
    }
    return expr;
  }

  if (minutes.length !== 1) return expr;
  const minute = minutes[0]!;

  if (everyDay) {
    const step = evenStep(hours, FULL.hours);
    if (step !== null) {
      return `Every ${step} hours at :${pad(minute)}`;
    }
    return `Daily ${times(hours, minute)} UTC`;
  }
  if (allDates && !allDows) {
    return `${days(ranges.dows)} ${times(hours, minute)} UTC`;
  }
  if (!allDates && allDows) {
    const on = ranges.dates.map(ordinal).join(", ");
    return `Monthly on the ${on} ${times(hours, minute)} UTC`;
  }
  return expr;
}
