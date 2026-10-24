import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  BUCKET_COUNT,
  EXIT_CRITERIA,
  HISTOGRAM_SCHEME,
  LATENCY_METRICS,
  PRESSURE_DECOMPRESSIONS_PER_SEC,
  PRESSURE_FREE_MEM_MB,
  SLOWEST_INTERACTIONS,
  THREAD_STALL_MS,
  countAtOrAbove,
  emptyCounts,
  percentileFromCounts,
  type LatencyMetric,
  type LatencyStat,
  type LatencySummary,
  type LatencyWindow,
} from "../../core";

const WINDOW_MS: Record<LatencyWindow, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

// THE definition of a minute's class — here and nowhere else, so there is no
// second copy to drift from it:
//   slept    the machine slept in it; its samples describe the nap
//   unknown  no host record: the server was not running, or not yet writing
//   pressure the duress latch was set, or memory was short (the two bars the
//            track's evidence was cut with, from core so the card can show them)
//   calm     everything else
// It runs in SQL so the histograms are summed in Postgres, off the serving thread:
// a 7-day window is tens of thousands of 67-number rows.
const minuteClass = sql`CASE
  WHEN h.minute_start IS NULL THEN 'unknown'
  WHEN h.slept_ms > 0 THEN 'slept'
  WHEN h.duress
    OR h.max_decompressions_per_sec > ${PRESSURE_DECOMPRESSIONS_PER_SEC}
    OR h.min_free_mem_mb < ${PRESSURE_FREE_MEM_MB} THEN 'pressure'
  ELSE 'calm'
END`;

const ClassSchema = z.enum(["calm", "pressure", "unknown", "slept"]);

const MetricRowSchema = z.object({
  metric: z.enum(LATENCY_METRICS),
  class: ClassSchema,
  counts: z.array(z.coerce.number()).length(BUCKET_COUNT),
  count: z.coerce.number(),
  max_ms: z.coerce.number(),
  censored: z.coerce.number(),
  excluded: z.coerce.number(),
});
type MetricRow = z.infer<typeof MetricRowSchema>;

const EMPTY_STAT: LatencyStat = {
  count: 0,
  p50Ms: null,
  p95Ms: null,
  maxMs: null,
  censored: 0,
};

function statOf(row: MetricRow | undefined): LatencyStat {
  if (!row || row.count === 0) return EMPTY_STAT;
  return {
    count: row.count,
    p50Ms: percentileFromCounts(row.counts, 0.5, row.max_ms),
    p95Ms: percentileFromCounts(row.counts, 0.95, row.max_ms),
    maxMs: row.max_ms,
    censored: row.censored,
  };
}

/**
 * The summary for one window — the `latency-ledger.summary` loader
 * (./summary-resource). Four aggregate reads over the window's rows.
 */
export async function loadLatencySummary(
  window: LatencyWindow,
): Promise<LatencySummary> {
  const since = new Date(Date.now() - WINDOW_MS[window]);

  // One row per (metric, class): the class's histograms added element-wise.
  const metricRows = await executeRows(db, {
    label: "latency-ledger:summary-metrics",
    row: MetricRowSchema,
    query: sql`
        WITH classed AS (
          SELECT m.metric, m.counts, m.count, m.max_ms, m.censored, m.excluded,
                 ${minuteClass} AS class
          FROM latency_ledger_minute m
          LEFT JOIN latency_ledger_host_minute h USING (minute_start)
          WHERE m.minute_start >= ${since} AND m.scheme = ${HISTOGRAM_SCHEME}
        ),
        summed AS (
          SELECT c.metric, c.class, u.i, sum(u.v)::int8 AS total
          FROM classed c, unnest(c.counts) WITH ORDINALITY AS u(v, i)
          GROUP BY c.metric, c.class, u.i
        ),
        arrays AS (
          SELECT metric, class, array_agg(total::float8 ORDER BY i) AS counts
          FROM summed GROUP BY metric, class
        )
        SELECT a.metric, a.class, a.counts,
               t.count, t.max_ms, t.censored, t.excluded
        FROM arrays a
        JOIN (
          SELECT metric, class, sum(count)::float8 AS count,
                 max(max_ms)::float8 AS max_ms,
                 sum(censored)::float8 AS censored,
                 sum(excluded)::float8 AS excluded
          FROM classed GROUP BY metric, class
        ) t USING (metric, class)`,
  });
  const byKey = new Map(metricRows.map((r) => [`${r.metric}:${r.class}`, r]));
  const row = (metric: LatencyMetric, cls: z.infer<typeof ClassSchema>) =>
    byKey.get(`${metric}:${cls}`);

  const minuteRows = await executeRows(db, {
    label: "latency-ledger:summary-minutes",
    row: z.object({ class: ClassSchema, n: z.coerce.number() }),
    query: sql`
        SELECT ${minuteClass} AS class, count(*)::float8 AS n
        FROM latency_ledger_host_minute h
        WHERE h.minute_start >= ${since}
        GROUP BY 1`,
  });
  const minutesOf = (cls: string): number =>
    minuteRows.find((r) => r.class === cls)?.n ?? 0;

  const metrics = LATENCY_METRICS.map((metric) => {
    const slept = row(metric, "slept");
    return {
      metric,
      calm: statOf(row(metric, "calm")),
      pressure: statOf(row(metric, "pressure")),
      unknown: statOf(row(metric, "unknown")),
      // Hidden-tab samples of every class, plus everything in a slept minute.
      excluded:
        (row(metric, "calm")?.excluded ?? 0) +
        (row(metric, "pressure")?.excluded ?? 0) +
        (row(metric, "unknown")?.excluded ?? 0) +
        (slept ? slept.count + slept.excluded : 0),
    };
  });

  const stallsOf = (cls: "calm" | "pressure") => {
    const r = row("thread-lag", cls);
    return {
      windows: r?.count ?? 0,
      over: countAtOrAbove(r?.counts ?? emptyCounts(), THREAD_STALL_MS),
    };
  };

  const criteria = EXIT_CRITERIA.map((c) => {
    const stat = statOf(row(c.metric, c.minuteClass));
    const valueMs = c.stat === "p95" ? stat.p95Ms : stat.maxMs;
    const verdict: "pass" | "fail" | "no-data" =
      valueMs === null
        ? "no-data"
        : (c.stat === "p95" ? valueMs < c.targetMs : valueMs <= c.targetMs)
          ? "pass"
          : "fail";
    return {
      id: c.id,
      label: c.label,
      targetMs: c.targetMs,
      valueMs,
      samples: stat.count,
      verdict,
    };
  });

  const ownerRows = await executeRows(db, {
    label: "latency-ledger:summary-owners",
    row: z.object({ owner: z.string(), n: z.coerce.number() }),
    query: sql`
        SELECT e.key AS owner, sum(e.value::float8)::float8 AS n
        FROM latency_ledger_thread_minute t, jsonb_each_text(t.owners) AS e
        WHERE t.minute_start >= ${since}
        GROUP BY e.key ORDER BY n DESC`,
  });
  const busyRows = await executeRows(db, {
    label: "latency-ledger:summary-busy",
    row: z.object({
      samples: z.coerce.number(),
      busy_ms: z.coerce.number(),
      minutes: z.coerce.number(),
    }),
    query: sql`
        SELECT coalesce(sum(samples), 0)::float8 AS samples,
               coalesce(sum(samples * period_ms), 0)::float8 AS busy_ms,
               count(*) FILTER (WHERE period_ms IS NOT NULL)::float8 AS minutes
        FROM latency_ledger_thread_minute
        WHERE minute_start >= ${since}`,
  });
  const busy = busyRows[0];
  const ownerTotal = ownerRows.reduce((sum, r) => sum + r.n, 0);

  const slowest = await executeRows(db, {
    label: "latency-ledger:summary-slowest",
    row: z.object({
      kind: z.enum(["page-load", "navigate"]),
      occurred_at: z.coerce.date(),
      route: z.string(),
      duration_ms: z.coerce.number(),
      hidden: z.boolean(),
      censored: z.boolean(),
      resource_count: z.coerce.number(),
      last_resource_key: z.string().nullable(),
    }),
    query: sql`
        SELECT kind, occurred_at, route, duration_ms, hidden, censored,
               resource_count, last_resource_key
        FROM latency_ledger_interaction
        WHERE occurred_at >= ${since} AND NOT hidden
        ORDER BY duration_ms DESC LIMIT ${SLOWEST_INTERACTIONS}`,
  });

  return {
    window,
    minutes: {
      calm: minutesOf("calm"),
      pressure: minutesOf("pressure"),
      slept: minutesOf("slept"),
    },
    metrics,
    threadStalls: {
      thresholdMs: THREAD_STALL_MS,
      calm: stallsOf("calm"),
      pressure: stallsOf("pressure"),
    },
    criteria,
    threadOwners: {
      samples: busy?.samples ?? 0,
      busyShare:
        busy && busy.minutes > 0
          ? Math.min(1, busy.busy_ms / (busy.minutes * 60_000))
          : null,
      owners:
        ownerTotal === 0
          ? []
          : ownerRows.map((r) => ({
              owner: r.owner,
              share: r.n / ownerTotal,
            })),
    },
    slowestInteractions: slowest.map((r) => ({
      kind: r.kind,
      occurredAt: r.occurred_at.getTime(),
      route: r.route,
      durationMs: r.duration_ms,
      hidden: r.hidden,
      censored: r.censored,
      resourceCount: r.resource_count,
      lastResourceKey: r.last_resource_key,
    })),
  };
}
