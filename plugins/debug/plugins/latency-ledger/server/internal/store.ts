import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  HISTOGRAM_SCHEME,
  type HistogramAcc,
  type Interaction,
  type LatencyMetric,
  type LedgerClient,
} from "../../core";
import {
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
  const t = _latencyLedgerMinute;
  await db
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
    // Across a restart inside the minute the later process wins: the owner map is
    // not mergeable in one statement, and half a minute of samples is no loss.
    .onConflictDoNothing();
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
