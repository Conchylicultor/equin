// THE reading of a job's crontab — the standard five fields (`m h dom mon dow`,
// UTC), which is the subset `defineJob({ schedule })` declares — for every host.
// The in-process queue (`jobs/plugins/in-process`) arms its timers from it, the
// desktop hands graphile a matcher built from it (`cronMatches`, as the cron
// item's `match` function — never a pattern string graphile would parse its own
// way), and the Background catalog describes and dates a schedule from it. So
// what a page says a schedule does cannot differ from what any scheduler does:
// there is one parse.
//
// Versus graphile's own grammar this is a superset (`a-b/n`, `n/step`, `5-5`),
// with one deliberate difference: a day field is unrestricted only when it is
// literally `*` (graphile also treats a field listing every value, `1-31`, as
// unrestricted). That only matters when both day fields are restricted, where
// cron fires when EITHER matches.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

/** A parsed crontab: each field's matching values, sorted and unique, and
 *  whether day of month and day of week were restricted (when both are, either
 *  matching fires). */
export interface Crontab {
  /** The expression as declared (trimmed). */
  readonly expr: string;
  /** 0-59 */
  readonly minutes: readonly number[];
  /** 0-23 */
  readonly hours: readonly number[];
  /** 1-31 */
  readonly dates: readonly number[];
  /** 1-12 */
  readonly months: readonly number[];
  /** 0-6, 0 = Sunday (a declared 7 reads as 0). */
  readonly dows: readonly number[];
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/** One UTC minute, field by field — the shape of graphile's `TimestampDigest`,
 *  so `cronMatches` is directly a graphile `CronMatcher`. */
export interface CronDigest {
  min: number;
  hour: number;
  date: number;
  month: number;
  dow: number;
}

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (m === null) {
      throw new Error(`[jobs] cron ${field.name}: cannot read "${part}"`);
    }
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const from = m[1] === "*" ? field.min : Number(m[2]);
    const to =
      m[1] === "*"
        ? field.max
        : m[3] === undefined
          ? m[4] === undefined
            ? from
            : field.max
          : Number(m[3]);
    if (step < 1 || from < field.min || to > field.max || from > to) {
      throw new Error(
        `[jobs] cron ${field.name}: "${part}" is outside ${field.min}-${field.max}`,
      );
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

const sorted = (set: ReadonlySet<number>): number[] =>
  [...set].sort((a, b) => a - b);

/** Parse a five-field crontab. Throws on anything else — a schedule that
 *  cannot be read must fail at install, never silently not fire. */
export function parseCrontab(expr: string): Crontab {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== FIELDS.length) {
    throw new Error(
      `[jobs] cron "${expr}": expected ${FIELDS.length} fields (m h dom mon dow)`,
    );
  }
  const [minutes, hours, dates, months, dows] = parts.map((p, i) =>
    parseField(p, FIELDS[i]!),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  // Day of week 7 is Sunday, like 0.
  if (dows.delete(7)) dows.add(0);
  return {
    expr: trimmed,
    minutes: sorted(minutes),
    hours: sorted(hours),
    dates: sorted(dates),
    months: sorted(months),
    dows: sorted(dows),
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

// Whether the crontab fires on a day at all. Standard cron: when both day
// fields are restricted, either one matching is enough; otherwise the
// restricted one (or neither) decides.
function dayMatches(
  tab: Crontab,
  date: number,
  month: number,
  dow: number,
): boolean {
  if (!tab.months.includes(month)) return false;
  // An unrestricted field is `*`, so it holds every value and passes here.
  const domOk = tab.dates.includes(date);
  const dowOk = tab.dows.includes(dow);
  if (tab.domRestricted && tab.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Whether the crontab fires at this minute. */
export function cronMatches(tab: Crontab, d: CronDigest): boolean {
  return (
    tab.minutes.includes(d.min) &&
    tab.hours.includes(d.hour) &&
    dayMatches(tab, d.date, d.month, d.dow)
  );
}

// A crontab that never matches (`0 0 31 2 *`) must end the search somewhere;
// four years and a day reaches every leap day (`0 0 29 2 *`). The search walks
// days, not minutes, so the whole span costs ~1.5k cheap day checks.
const LOOKAHEAD_DAYS = 4 * 366 + 1;

// The first (hour, minute) of the crontab at or after `hour:minute` of a day.
function firstTimeFrom(
  tab: Crontab,
  hour: number,
  minute: number,
): { hour: number; minute: number } | null {
  for (const h of tab.hours) {
    if (h < hour) continue;
    const m =
      h === hour ? tab.minutes.find((v) => v >= minute) : tab.minutes[0];
    if (m !== undefined) return { hour: h, minute: m };
  }
  return null;
}

/** The first minute strictly after `from` the crontab fires at, or `null`
 *  when it does not fire within four years. */
export function nextCronFiring(tab: Crontab, from: Date): Date | null {
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const day = new Date(start.getTime());
  day.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
    if (
      dayMatches(tab, day.getUTCDate(), day.getUTCMonth() + 1, day.getUTCDay())
    ) {
      const time =
        i === 0
          ? firstTimeFrom(tab, start.getUTCHours(), start.getUTCMinutes())
          : firstTimeFrom(tab, 0, 0);
      if (time !== null) {
        const at = new Date(day.getTime());
        at.setUTCHours(time.hour, time.minute);
        return at;
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return null;
}
