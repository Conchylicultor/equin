// A portable reading of a job's crontab — the standard five fields
// (`m h dom mon dow`, UTC), which is the subset `defineJob({ schedule })`
// declares — for a host whose queue schedules in process
// (`jobs/plugins/in-process`). The desktop schedules through graphile's own
// cron, so this never decides when a desktop job fires.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

/** A parsed crontab: the allowed values of each field, and whether day of
 *  month and day of week were both restricted (then either matching fires). */
export interface Crontab {
  readonly sets: readonly ReadonlySet<number>[];
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
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

/** Parse a five-field crontab. Throws on anything else — a schedule that
 *  cannot be read must fail at install, never silently not fire. */
export function parseCrontab(expr: string): Crontab {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) {
    throw new Error(
      `[jobs] cron "${expr}": expected ${FIELDS.length} fields (m h dom mon dow)`,
    );
  }
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]!));
  // Day of week 7 is Sunday, like 0.
  if (sets[4]!.has(7)) sets[4]!.add(0);
  return {
    sets,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function matches(tab: Crontab, d: Date): boolean {
  const [min, hour, dom, mon, dow] = tab.sets;
  if (!min!.has(d.getUTCMinutes()) || !hour!.has(d.getUTCHours())) return false;
  if (!mon!.has(d.getUTCMonth() + 1)) return false;
  const domOk = dom!.has(d.getUTCDate());
  const dowOk = dow!.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either one matching
  // is enough; otherwise the restricted one (or neither) decides.
  if (tab.domRestricted && tab.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

// A crontab that never matches (`0 0 31 2 *`) must end the search somewhere.
const LOOKAHEAD_MINUTES = 366 * 24 * 60;

/** The first minute strictly after `from` the crontab fires at, or `null`
 *  when it does not fire within a year. */
export function nextCronFiring(tab: Crontab, from: Date): Date | null {
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < LOOKAHEAD_MINUTES; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (matches(tab, t)) return new Date(t.getTime());
  }
  return null;
}
