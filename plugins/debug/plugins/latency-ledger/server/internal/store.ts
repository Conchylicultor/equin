import { sql } from "drizzle-orm";
import { db, writeAtomically } from "@plugins/database/server";
import {
  HISTOGRAM_SCHEME,
  type ClientLatencyMetric,
  type HistogramAcc,
  type Interaction,
  type LatencyMetric,
  type LedgerClient,
} from "../../core";
import {
  _latencyLedgerClientMinute,
  _latencyLedgerHostMinute,
  _latencyLedgerInteraction,
  _latencyLedgerMinute,
  _latencyLedgerThreadMinute,
} from "./tables";

// The ledger's durable writes. Every one is a single-statement upsert with no
// read-modify-write, so the browser's minute and the server's minute for the same
// (metric, minute) can land in either order, from any number of tabs.

export interface MetricMinute {
  metric: LatencyMetric;
  minuteStart: number;
  acc: HistogramAcc;
}

export interface HostMinute {
  minuteStart: number;
  duress: boolean;
  maxDecompressionsPerSec: number | null;
  minFreeMemMb: number | null;
  maxLoad1: number | null;
  sleptMs: number;
}

export interface ThreadMinute {
  minuteStart: number;
  samples: number;
  periodMs: number | null;
  owners: Record<string, number>;
}

/** Add one minute's histogram into its row (creating it). */
export async function mergeMetricMinute(m: MetricMinute): Promise<void> {
  await metricMinuteUpsert(m);
}

/**
 * Add a browser batch's minute into the combined row AND its tab kind's row,
 * in one statement — so the split never disagrees with the combined row it
 * splits (./tables.ts, `latency_ledger_client_minute`).
 */
export async function mergeClientMinute(
  m: MetricMinute & {
    metric: ClientLatencyMetric;
    clientKind: "real" | "automated";
  },
): Promise<void> {
  const t = _latencyLedgerClientMinute;
  await writeAtomically(db, [
    metricMinuteUpsert(m),
    db
      .insert(t)
      .values({
        metric: m.metric,
        minuteStart: new Date(m.minuteStart),
        clientKind: m.clientKind,
        scheme: HISTOGRAM_SCHEME,
        counts: m.acc.counts,
        count: m.acc.count,
        sumMs: m.acc.sumMs,
        maxMs: m.acc.maxMs,
        censored: m.acc.censored,
        excluded: m.acc.excluded,
      })
      .onConflictDoUpdate({
        target: [t.metric, t.minuteStart, t.clientKind],
        set: {
          counts: sql`(SELECT array_agg(a + b ORDER BY i) FROM unnest(${t.counts}, EXCLUDED.counts) WITH ORDINALITY AS u(a, b, i))`,
          count: sql`${t.count} + EXCLUDED.count`,
          sumMs: sql`${t.sumMs} + EXCLUDED.sum_ms`,
          maxMs: sql`greatest(${t.maxMs}, EXCLUDED.max_ms)`,
          censored: sql`${t.censored} + EXCLUDED.censored`,
          excluded: sql`${t.excluded} + EXCLUDED.excluded`,
        },
        setWhere: sql`${t.scheme} = EXCLUDED.scheme`,
      }),
  ]);
}

function metricMinuteUpsert(m: MetricMinute) {
  const t = _latencyLedgerMinute;
  return db
    .insert(t)
    .values({
      metric: m.metric,
      minuteStart: new Date(m.minuteStart),
      scheme: HISTOGRAM_SCHEME,
      counts: m.acc.counts,
      count: m.acc.count,
      sumMs: m.acc.sumMs,
      maxMs: m.acc.maxMs,
      censored: m.acc.censored,
      excluded: m.acc.excluded,
    })
    .onConflictDoUpdate({
      target: [t.metric, t.minuteStart],
      set: {
        // Element-wise sum of the two arrays. Sound only because both are aligned
        // to the same scheme — which `setWhere` below guarantees.
        counts: sql`(SELECT array_agg(a + b ORDER BY i) FROM unnest(${t.counts}, EXCLUDED.counts) WITH ORDINALITY AS u(a, b, i))`,
        count: sql`${t.count} + EXCLUDED.count`,
        sumMs: sql`${t.sumMs} + EXCLUDED.sum_ms`,
        maxMs: sql`greatest(${t.maxMs}, EXCLUDED.max_ms)`,
        censored: sql`${t.censored} + EXCLUDED.censored`,
        excluded: sql`${t.excluded} + EXCLUDED.excluded`,
      },
      // A row written under another bucket scheme is left alone rather than
      // corrupted; the query ignores it, and retention ages it out.
      setWhere: sql`${t.scheme} = EXCLUDED.scheme`,
    });
}

export async function mergeHostMinute(h: HostMinute): Promise<void> {
  const t = _latencyLedgerHostMinute;
  await db
    .insert(t)
    .values({
      minuteStart: new Date(h.minuteStart),
      duress: h.duress,
      maxDecompressionsPerSec: h.maxDecompressionsPerSec,
      minFreeMemMb: h.minFreeMemMb,
      maxLoad1: h.maxLoad1,
      sleptMs: h.sleptMs,
    })
    .onConflictDoUpdate({
      target: t.minuteStart,
      // A minute is written twice only across a restart inside it: keep the worse
      // reading of each signal. greatest/least ignore a NULL side.
      set: {
        duress: sql`${t.duress} OR EXCLUDED.duress`,
        maxDecompressionsPerSec: sql`greatest(${t.maxDecompressionsPerSec}, EXCLUDED.max_decompressions_per_sec)`,
        minFreeMemMb: sql`least(${t.minFreeMemMb}, EXCLUDED.min_free_mem_mb)`,
        maxLoad1: sql`greatest(${t.maxLoad1}, EXCLUDED.max_load1)`,
        sleptMs: sql`${t.sleptMs} + EXCLUDED.slept_ms`,
      },
    });
}

export async function writeThreadMinute(m: ThreadMinute): Promise<void> {
  const t = _latencyLedgerThreadMinute;
  await db
    .insert(t)
    .values({
      minuteStart: new Date(m.minuteStart),
      samples: m.samples,
      periodMs: m.periodMs,
      owners: m.owners,
    })
    // Written twice across a restart inside the minute: the stopping process
    // flushes its partial minute first, then the new one writes its boot. Both
    // halves are kept — samples and owner counts summed, the period weighted by
    // samples so `samples × periodMs` (time on the thread) stays the sum of the
    // two. Doing nothing here dropped the booting half: the restart minute, the
    // one this table exists to explain (main, 2026-11-17 23:57 UTC, read as 3.8 s
    // busy while the boot queued 101 reads).
    .onConflictDoUpdate({
      target: t.minuteStart,
      set: {
        samples: sql`${t.samples} + EXCLUDED.samples`,
        periodMs: sql`CASE
          WHEN ${t.periodMs} IS NULL THEN EXCLUDED.period_ms
          WHEN EXCLUDED.period_ms IS NULL THEN ${t.periodMs}
          ELSE (${t.samples} * ${t.periodMs} + EXCLUDED.samples * EXCLUDED.period_ms)
               / nullif(${t.samples} + EXCLUDED.samples, 0)
        END`,
        owners: sql`(
          SELECT coalesce(jsonb_object_agg(u.key, u.n), '{}'::jsonb)
          FROM (
            SELECT e.key, sum(e.value::float8) AS n
            FROM (
              SELECT * FROM jsonb_each_text(${t.owners})
              UNION ALL
              SELECT * FROM jsonb_each_text(EXCLUDED.owners)
            ) AS e
            GROUP BY e.key
          ) AS u
        )`,
      },
    });
}

export async function insertInteractions(
  rows: Interaction[],
  client: LedgerClient | undefined,
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(_latencyLedgerInteraction).values(
    rows.map((r) => ({
      occurredAt: new Date(r.occurredAt),
      kind: r.kind,
      route: r.route,
      placeKey: r.placeKey ?? null,
      durationMs: r.durationMs,
      hidden: r.hidden,
      censored: r.censored,
      resourceCount: r.resourceCount,
      lastResourceKey: r.lastResourceKey,
      clientId: client?.tabId ?? null,
      automated: client?.automated ?? false,
    })),
  );
}
