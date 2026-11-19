import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, writeAtomically } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  BUCKET_COUNT,
  HISTOGRAM_SCHEME,
  CLIENT_METRICS,
  LATENCY_CLIENT_KINDS,
  LATENCY_METRICS,
  percentileFromCounts,
  type DailyLatency,
} from "../../core";
import { minuteClass } from "./query";

// The ledger by UTC day. A closed day never changes, so it is added up ONCE
// (`latency-ledger.roll-days`, hourly) into `latency_ledger_day` — a 30-day
// trend then reads a few hundred rows, where summing the minute histograms took
// 3.5 s on main (2026-11-19, ~116k rows × 67 buckets) and grows with the window.
// The days not rolled yet — today, and yesterday until the browser's late
// batches can no longer reach it — are summed live from the minute table: a day
// and a half at most.

const DAY_MS = 24 * 60 * 60_000;
// A browser batch may carry a minute up to 6 h old (ingest's MAX_AGE_MS): a day
// is rolled only once no batch can still add to it.
const ROLL_AFTER_CLOSE_MS = 7 * 60 * 60_000;
// The minute table keeps 35 days; an older day can no longer be rolled whole.
const ROLLABLE_DAYS = 34;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Every boundary is a UTC instant handed in as a parameter, and every day is
// read with `AT TIME ZONE 'UTC'`: the database session runs in the machine's
// own zone (Europe/Paris on main), so `'2026-11-18'::date::timestamptz` would
// be local midnight and a "day" would straddle two UTC days.
const utcStart = (day: string): Date => new Date(`${day}T00:00:00Z`);

// The browser metrics, whose combined rows are every tab's (`all`); the others
// are the server's own.
const CLIENT_METRIC_LIST = sql.join(
  CLIENT_METRICS.map((m) => sql`${m}`),
  sql`, `,
);

/**
 * The minute rows in [from, to), summed per (UTC day, metric, client kind,
 * class): the combined table as `all` (a browser metric) or `server`, and the
 * per-tab split as `real` / `automated`.
 */
function dayRowsSql(from: string, to: string): SQL {
  const lo = utcStart(from);
  const hi = utcStart(to);
  return sql`
    WITH minutes AS (
      SELECT m.minute_start, m.metric,
             CASE WHEN m.metric IN (${CLIENT_METRIC_LIST}) THEN 'all' ELSE 'server' END
               AS client_kind,
             m.counts, m.count, m.max_ms, m.censored, m.excluded
      FROM latency_ledger_minute m
      WHERE m.minute_start >= ${lo} AND m.minute_start < ${hi}
        AND m.scheme = ${HISTOGRAM_SCHEME}
      UNION ALL
      SELECT c.minute_start, c.metric, c.client_kind,
             c.counts, c.count, c.max_ms, c.censored, c.excluded
      FROM latency_ledger_client_minute c
      WHERE c.minute_start >= ${lo} AND c.minute_start < ${hi}
        AND c.scheme = ${HISTOGRAM_SCHEME}
    ),
    classed AS (
      SELECT (m.minute_start AT TIME ZONE 'UTC')::date AS day,
             m.metric, m.client_kind, m.counts, m.count, m.max_ms,
             m.censored, m.excluded, ${minuteClass} AS minute_class
      FROM minutes m
      -- Bounded to the window too, so the host table is read by its key range,
      -- never scanned whole.
      LEFT JOIN latency_ledger_host_minute h
        ON h.minute_start = m.minute_start
       AND h.minute_start >= ${lo} AND h.minute_start < ${hi}
    ),
    summed AS (
      SELECT c.day, c.metric, c.client_kind, c.minute_class, u.i,
             sum(u.v)::int8 AS total
      FROM classed c, unnest(c.counts) WITH ORDINALITY AS u(v, i)
      GROUP BY 1, 2, 3, 4, 5
    ),
    arrays AS (
      SELECT day, metric, client_kind, minute_class,
             array_agg(total::int4 ORDER BY i) AS counts
      FROM summed GROUP BY 1, 2, 3, 4
    )
    SELECT a.day::text AS day, a.metric, a.client_kind, a.minute_class,
           a.counts, t.count, t.max_ms, t.censored, t.excluded
    FROM arrays a
    JOIN (
      SELECT day, metric, client_kind, minute_class,
             sum(count)::int4 AS count, max(max_ms)::float8 AS max_ms,
             sum(censored)::int4 AS censored, sum(excluded)::int4 AS excluded
      FROM classed GROUP BY 1, 2, 3, 4
    ) t USING (day, metric, client_kind, minute_class)`;
}

/** The host minutes in [from, to), counted per UTC day and class (days with none absent). */
function hostDaysSql(from: string, to: string): SQL {
  return sql`
    SELECT (h.minute_start AT TIME ZONE 'UTC')::date::text AS day,
           count(*) FILTER (WHERE ${minuteClass} = 'calm')::int4 AS calm,
           count(*) FILTER (WHERE ${minuteClass} = 'pressure')::int4 AS pressure,
           count(*) FILTER (WHERE ${minuteClass} = 'slept')::int4 AS slept,
           count(*)::int4 AS recorded
    FROM latency_ledger_host_minute h
    WHERE h.minute_start >= ${utcStart(from)} AND h.minute_start < ${utcStart(to)}
    GROUP BY 1`;
}

const DayRowSchema = z.object({
  day: z.string(),
  metric: z.enum(LATENCY_METRICS),
  client_kind: z.enum(LATENCY_CLIENT_KINDS),
  minute_class: z.enum(["calm", "pressure", "unknown", "slept"]),
  counts: z.array(z.coerce.number()).length(BUCKET_COUNT),
  count: z.coerce.number(),
  max_ms: z.coerce.number(),
  censored: z.coerce.number(),
  excluded: z.coerce.number(),
});
type DayRow = z.infer<typeof DayRowSchema>;

const HostDayRowSchema = z.object({
  day: z.string(),
  calm: z.coerce.number(),
  pressure: z.coerce.number(),
  slept: z.coerce.number(),
  recorded: z.coerce.number(),
});

/** Roll one closed day: its metric rows and its host row, in one statement. */
async function rollDay(day: string): Promise<void> {
  const next = dayOf(Date.parse(`${day}T00:00:00Z`) + DAY_MS);
  // One statement (a data-modifying CTE), so the host row — the day's
  // "rolled" mark — never lands without the metric rows.
  await writeAtomically(db, [
    // sql-writes:hand-written — INSERT … SELECT of a day's summed histograms (unnest + array_agg), which drizzle's insert builder cannot express
    sql`
      INSERT INTO latency_ledger_day
        (day, metric, client_kind, minute_class, scheme, counts, count,
         max_ms, censored, excluded)
      SELECT r.day::date, r.metric, r.client_kind, r.minute_class,
             ${HISTOGRAM_SCHEME}, r.counts, r.count, r.max_ms, r.censored,
             r.excluded
      FROM (${dayRowsSql(day, next)}) r
      ON CONFLICT DO NOTHING`,
    // sql-writes:hand-written — INSERT … SELECT of a day's minutes counted by class
    sql`
      INSERT INTO latency_ledger_host_day
        (day, calm_minutes, pressure_minutes, slept_minutes, unknown_minutes)
      SELECT ${day}::date,
             coalesce(sum(h.calm), 0)::int4, coalesce(sum(h.pressure), 0)::int4,
             coalesce(sum(h.slept), 0)::int4,
             greatest(0, 1440 - coalesce(sum(h.recorded), 0))::int4
      FROM (${hostDaysSql(day, next)}) h
      ON CONFLICT DO NOTHING`,
  ]);
}

async function rolledDaysSince(sinceDay: string): Promise<Set<string>> {
  const rows = await executeRows(db, {
    label: "latency-ledger:rolled-days",
    row: z.object({ day: z.string() }),
    query: sql`SELECT day::text AS day FROM latency_ledger_host_day WHERE day >= ${sinceDay}::date`,
  });
  return new Set(rows.map((r) => r.day));
}

/** Every closed, still-rollable day without its host-day row, oldest first. */
export async function rollClosedDays(now = Date.now()): Promise<number> {
  const lastClosed = dayOf(now - ROLL_AFTER_CLOSE_MS - DAY_MS);
  const first = dayOf(now - ROLLABLE_DAYS * DAY_MS);
  if (first > lastClosed) return 0;
  const rolled = await rolledDaysSince(first);
  const missing: string[] = [];
  for (
    let ms = Date.parse(`${first}T00:00:00Z`);
    dayOf(ms) <= lastClosed;
    ms += DAY_MS
  )
    if (!rolled.has(dayOf(ms))) missing.push(dayOf(ms));
  for (const day of missing) await rollDay(day);
  return missing.length;
}

export const rollDaysJob = defineJob({
  name: "latency-ledger.roll-days",
  description:
    "Adds up each finished day of the latency ledger once, so the responsiveness trend over weeks reads a few rows per day instead of every minute.",
  // One day's sum is ~0.1 s; a fresh install's backfill of 34 days a few seconds.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  // Hourly, not daily: a missed run (the machine asleep at the hour) is caught
  // up by the next one, and the first run after a deploy backfills.
  schedule: { cron: "17 * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    await rollClosedDays();
  },
});

function statsOf(rows: readonly DayRow[]): DailyLatency["metrics"][number] {
  const counts = new Array<number>(BUCKET_COUNT).fill(0);
  let count = 0;
  let maxMs = 0;
  let censored = 0;
  let excluded = 0;
  for (const r of rows) {
    // A slept minute's samples describe the nap, not the app.
    if (r.minute_class === "slept") {
      excluded += r.count + r.excluded;
      continue;
    }
    r.counts.forEach((n, i) => (counts[i] = (counts[i] ?? 0) + n));
    count += r.count;
    maxMs = Math.max(maxMs, r.max_ms);
    censored += r.censored;
    excluded += r.excluded;
  }
  const first = rows[0];
  if (!first) throw new Error("statsOf: no rows");
  return {
    day: first.day,
    metric: first.metric,
    clientKind: first.client_kind,
    counts,
    count,
    p50Ms: count === 0 ? null : percentileFromCounts(counts, 0.5, maxMs),
    p95Ms: count === 0 ? null : percentileFromCounts(counts, 0.95, maxMs),
    maxMs: count === 0 ? null : maxMs,
    censored,
    excluded,
  };
}

/**
 * The ledger per UTC day since `sinceDay` (inclusive, `YYYY-MM-DD`), today
 * included: p50 / p95 per (metric, client kind) over every minute the machine
 * was awake, and the machine's minutes by class. Rolled days are read; the
 * rest are summed live.
 */
export async function loadDailyLatency(
  sinceDay: string,
  now = Date.now(),
): Promise<DailyLatency> {
  const tomorrow = dayOf(now + DAY_MS);
  const rolledHosts = await executeRows(db, {
    label: "latency-ledger:daily-host-rolled",
    row: z.object({
      day: z.string(),
      calm: z.coerce.number(),
      pressure: z.coerce.number(),
      slept: z.coerce.number(),
      unknown: z.coerce.number(),
    }),
    query: sql`
      SELECT day::text AS day, calm_minutes AS calm,
             pressure_minutes AS pressure, slept_minutes AS slept,
             unknown_minutes AS unknown
      FROM latency_ledger_host_day WHERE day >= ${sinceDay}::date
      ORDER BY day`,
  });
  const rolled = new Set(rolledHosts.map((h) => h.day));
  // Only the days the host read saw rolled: one the job rolls between the two
  // reads is summed live below, never counted twice.
  const rolledRowsRead = await executeRows(db, {
    label: "latency-ledger:daily-rolled",
    row: DayRowSchema,
    query: sql`
      SELECT day::text AS day, metric, client_kind, minute_class, counts,
             count, max_ms, censored, excluded
      FROM latency_ledger_day
      WHERE day >= ${sinceDay}::date AND scheme = ${HISTOGRAM_SCHEME}`,
  });
  const rolledRows = rolledRowsRead.filter((r) => rolled.has(r.day));
  // The open days: from the first day after the newest rolled one (or the
  // window's start) to today. Normally one or two; a day the job has not
  // reached yet in the middle is summed live too.
  const days: string[] = [];
  for (
    let ms = Date.parse(`${sinceDay}T00:00:00Z`);
    dayOf(ms) < tomorrow;
    ms += DAY_MS
  )
    days.push(dayOf(ms));
  const open = days.filter((d) => !rolled.has(d));
  const liveRows: DayRow[] = [];
  const liveHosts: DailyLatency["hosts"] = [];
  // Contiguous runs of open days, one live query each.
  for (const run of runsOf(open)) {
    const from = run[0];
    const last = run[run.length - 1];
    if (from === undefined || last === undefined) continue;
    const to = dayOf(Date.parse(`${last}T00:00:00Z`) + DAY_MS);
    liveRows.push(
      ...(await executeRows(db, {
        label: "latency-ledger:daily-live",
        row: DayRowSchema,
        query: dayRowsSql(from, to),
      })),
    );
    const hosts = await executeRows(db, {
      label: "latency-ledger:daily-host-live",
      row: HostDayRowSchema,
      query: hostDaysSql(from, to),
    });
    const byDay = new Map(hosts.map((h) => [h.day, h]));
    for (const day of run) {
      const h = byDay.get(day);
      // Today's minutes still to come are not "unknown": count only those past.
      const elapsed = Math.min(
        1440,
        Math.max(
          0,
          Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / 60_000),
        ),
      );
      liveHosts.push({
        day,
        calmMinutes: h?.calm ?? 0,
        pressureMinutes: h?.pressure ?? 0,
        sleptMinutes: h?.slept ?? 0,
        unknownMinutes: Math.max(0, elapsed - (h?.recorded ?? 0)),
      });
    }
  }

  const groups = new Map<string, DayRow[]>();
  for (const r of [...rolledRows, ...liveRows]) {
    const key = `${r.day}|${r.metric}|${r.client_kind}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return {
    metrics: [...groups.values()].map(statsOf),
    hosts: [
      ...rolledHosts.map((h) => ({
        day: h.day,
        calmMinutes: h.calm,
        pressureMinutes: h.pressure,
        sleptMinutes: h.slept,
        unknownMinutes: h.unknown,
      })),
      ...liveHosts,
    ].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

function runsOf(days: readonly string[]): string[][] {
  const runs: string[][] = [];
  for (const d of days) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (
      run &&
      prev &&
      Date.parse(`${d}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`) === DAY_MS
    )
      run.push(d);
    else runs.push([d]);
  }
  return runs;
}
