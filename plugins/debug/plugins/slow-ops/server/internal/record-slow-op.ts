import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
  type SpanDetail,
  type WaitBreakdown,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { recordReport } from "@plugins/reports/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  getContentionSnapshot,
  type ContentionSnapshot,
} from "@plugins/infra/plugins/host/plugins/contention/server";
import {
  createShedBuffer,
  type ShedSummary,
} from "@plugins/infra/plugins/host/plugins/duress/server";
import type { ReportSource } from "@plugins/reports/core";
import type {
  CallerBreakdown,
  CallerRef,
  SlowOpMarker,
  SlowOpSample,
} from "../../core";
import { mergeMeasures, mergeVariant } from "./merge-detail";
import { _slowOps } from "./tables";

// The only report sources a slow-op originates from — narrowed from the
// canonical ReportSource union (now in reports/core), so this stays a checked
// subset of the real origins rather than a drifting hand-rolled copy.
type SlowOpSource = Extract<
  ReportSource,
  "server-slow-op" | "client-slow-op" | "server-boot-monitor"
>;

// A slim overlay marker per recorded slow op, dual-written to a durable log
// channel. Mirrors the health sampler's `defineLogSink({ id: "health" })` — each
// worktree backend writes to its own logs/slow-op-markers.jsonl, read from disk by
// the health-monitor endpoint to draw spike lines on the charts. Uncapped (one
// line per slow op), unlike the 10-entry DB recentSamples ring.
const markerChannel = defineLogSink({
  id: "slow-op-markers",
  description:
    "PERF sink: one marker line per recorded slow op, read from disk to draw spike lines on the Debug → Health charts.",
  consumer: {
    kind: "rendering-only",
    note: "Per-worktree slow-op markers overlaid on the Debug → Health pane (readSlowOpMarkers). The durable slow-op SIGNAL is the slow-op report filed on the DB path by the same recorder; this channel is display-only.",
  },
});

export interface RecordSlowOpInput {
  operationKind: string;
  operation: string;
  durationMs: number;
  thresholdMs: number;
  // The report source attributed to the rollup report (server-slow-op vs
  // client-slow-op). The funnel doesn't infer it — the caller knows its origin.
  source: SlowOpSource;
  // Who issued this operation, when known. The caller-attribution fix: this is
  // what the whole refactor exists to capture. Server spans pass their immediate
  // enclosing span (a SpanRef); client `element` signals pass their route
  // ({ kind: "route", label }); page-load passes nothing.
  caller?: CallerRef | null;
  // Per-layer wait charged to this entry span (gate/lock → ms), when it waited.
  // Merged per layer into the row's durable `waits` so the wait-vs-work split
  // survives restart. Only entry spans (loader/http/sub/push) carry it.
  waits?: WaitBreakdown;
  // The tripping span's variant (which instance ran — a loader's params) and
  // measures (fan-out, frame size, …). Merged into the row's `variants`
  // breakdown and `measures` stats, and stamped on the newest sample.
  detail?: SpanDetail;
  // Additive cold-start attribution (client `element` signal only). When the
  // notifications transport was not ready at resource mount, this duration is
  // transport time-to-first-data, not resource compute. Threaded into the report
  // `data` (jsonb — no migration) so the report title/description says WHY.
  transportColdStart?: boolean;
  transportWaitMs?: number;
  // The durable trace captured for this same trip (when the engine admitted
  // one). Stamped into the newest recentSamples entry and the report `data` so
  // the aggregate view and the slow-op task both deep-link the evidence. Null
  // when the trace was rate-limited or the engine is disabled.
  traceId?: string;
  // The instant the span actually tripped. Stamped by recordSlowOp itself
  // BEFORE the duress shed gate, so an item buffered during a duress episode
  // replays with its true in-freeze instant (recentSamples atTime, marker
  // line, lastSeenAt) instead of the post-episode flush time. Callers omit it.
  occurredAt?: Date;
}

// Merge a caller into the existing breakdown list: bump an existing entry
// matched by (kind,label), else append a fresh one.
function mergeCaller(
  callers: CallerBreakdown[],
  caller: CallerRef,
  durationMs: number,
): CallerBreakdown[] {
  const next = callers.map((c) => ({ ...c }));
  const existing = next.find(
    (c) => c.kind === caller.kind && c.label === caller.label,
  );
  if (existing) {
    existing.count += 1;
    existing.totalMs += durationMs;
    if (durationMs > existing.maxMs) existing.maxMs = durationMs;
  } else {
    next.push({
      kind: caller.kind,
      label: caller.label,
      count: 1,
      totalMs: durationMs,
      maxMs: durationMs,
    });
  }
  return next;
}

// Sum an incoming per-layer wait map into the existing one (layer → total ms).
// A plain additive merge mirroring the aggregate's wait accumulation.
function mergeWaits(
  existing: WaitBreakdown,
  incoming: WaitBreakdown,
): WaitBreakdown {
  const next: WaitBreakdown = { ...existing };
  for (const layer in incoming) {
    next[layer] = (next[layer] ?? 0) + incoming[layer]!;
  }
  return next;
}

// Insert the new contention sample and cap the ring at the newest 10. Mirrors
// the `callers` read-modify-write merge, but a bounded insert (no dedupe) —
// each sample is a distinct point-in-time capture, stamped with the trip's
// true `occurredAt`. Sorted newest-first by atTime (not prepend order): a
// duress-shed item replays after the episode with an in-freeze occurredAt, so
// arrival order is not time order — sorting keeps the "newest 10" contract
// honest under out-of-order replay.
export function mergeSample(
  samples: SlowOpSample[],
  snapshot: ContentionSnapshot,
  durationMs: number,
  traceId: string | undefined,
  occurredAt: Date,
  detail?: SpanDetail,
): SlowOpSample[] {
  const sample: SlowOpSample = {
    atTime: occurredAt,
    durationMs,
    snapshot,
    traceId,
  };
  if (detail?.variant !== undefined) sample.variant = detail.variant;
  if (detail?.measures) sample.measures = detail.measures;
  return [sample, ...samples]
    .sort(
      // atTime is a Date in fresh entries but an ISO string once round-tripped
      // through the jsonb column — normalize before comparing.
      (a, b) => new Date(b.atTime).getTime() - new Date(a.atTime).getTime(),
    )
    .slice(0, 10);
}

function shedSummaryMessage(s: ShedSummary): string {
  const shed = Object.values(s.byCascade).reduce((a, c) => a + c.shed, 0);
  const dropped = Object.values(s.byCascade).reduce((a, c) => a + c.dropped, 0);
  return (
    `duress episode cleared: ${s.kind} buffer shed ${shed} + dropped ${dropped} ` +
    `across ${Object.keys(s.byCascade).length} cascade keys ` +
    `(${s.replayed} replayed, ${s.replayErrors} replay errors)`
  );
}

// Duress shed gate for the slow-op durable path (Phase C2). During a host
// duress episode, past the first-N-per-cascade grant the FULL input is
// buffered and the funnel below is skipped; after the episode clears, replay
// re-drives recordSlowOp per item — the aggregate upsert's onConflictDoUpdate
// merge is idempotent per item and order-insensitive, so counts / totals /
// maxMs stay truthful post-flush. Each buffered item carries the `occurredAt`
// stamped before admit, so replayed recentSamples / marker lines / lastSeenAt
// land at their true in-freeze instants, not the flush time — and the
// newest-occurrence guards in the upsert keep an out-of-order replay from
// clobbering fresher last-* attribution.
const slowOpShed = createShedBuffer<RecordSlowOpInput>({
  kind: "slow-ops",
  // The upsert key: the same axis the durable aggregate dedupes on.
  cascadeKeyOf: (i) => `${i.operationKind}:${i.operation}`,
  replay: async (items) => {
    for (const item of items) await recordSlowOp(item);
  },
  // File the post-episode accounting through the reports funnel. The
  // `duress-shed` kind is registered by debug/duress-shed and marks itself
  // duressExempt, so this summary can never itself be shed.
  onFlushSummary: (s) => {
    void recordReport({
      kind: "duress-shed",
      source: "server-duress-shed",
      message: shedSummaryMessage(s),
      data: { ...s },
    });
  },
});

// THE single ingest funnel for every slow-op signal — the server span hook and
// the client endpoint both collapse here. Upserts the deduped aggregate by
// (operationKind, operation, worktree), merges the caller attribution, and
// fires the per-operation report (fire-and-forget so a slow report path never
// blocks recording). Failures propagate loudly.
//
// A single signal is a batch of one: the server-span path and the client
// beacon stay ONE funnel, with one code path between them.
export async function recordSlowOp(input: RecordSlowOpInput): Promise<void> {
  await recordSlowOpBatch([input]);
}

// The batch form. The client beacon arrives as a batch (one boot wave can
// re-settle hundreds of resources at once), and opening a Postgres transaction
// per item was the other half of the amplification the batching exists to stop
// — 210 commits during a stall, against the backend that IS the stall. One
// contention snapshot and ONE transaction cover the whole batch.
//
// Nothing is filtered here. Every input that clears the shed gate is upserted,
// markered, and reported exactly as it would have been alone.
export async function recordSlowOpBatch(
  inputs: RecordSlowOpInput[],
): Promise<void> {
  // Stamp + shed-gate PER ITEM, and before anything else. Both halves are
  // per-item by construction:
  //
  // - the stamp is the trip instant, taken BEFORE the shed gate so a buffered
  //   item carries its true time through the buffer and replay writes in-freeze
  //   instants, not the flush time. Replay re-passes the same object, so the
  //   stamp survives the buffer and the ??= is a no-op on the replay pass;
  // - the shed gate counts first-N per cascade key, so batching the admission
  //   decision would change which items survive a duress episode.
  //
  // The gate applies to the durable-write funnel ONLY. The coherent-instant
  // trace for the same trip is captured by the CALLERS (install-slow-span /
  // handle-client-slow-op) BEFORE this call — evidence-first — and carries its
  // own independent shed gate inside captureTrace, so first-N traces still land
  // even when this row write is shed (and vice versa).
  const admitted: RecordSlowOpInput[] = [];
  for (const input of inputs) {
    input.occurredAt ??= new Date();
    if (!slowOpShed.admit(input).persist) continue;
    admitted.push(input);
  }
  if (admitted.length === 0) return;

  // One transaction so each onConflictDoUpdate row lock serializes concurrent
  // callers for the same key, making the callers read-merge-write race-tolerant.
  // Wrapped in runWithoutProfiling: the slow_ops upsert is itself a `db` span that
  // would otherwise re-feed the slow-op recorder (self-amplifying loop). The
  // suppression ALS propagates through every awaited query inside the callback.
  // Hoisted out of the suppression callback so the dual-write markers below can
  // reuse the same captured box state. Assigned inside the scope (the await must
  // stay there); non-null after the callback resolves.
  //
  // Wrapped OUTSIDE that in runInBackgroundLane: without the declaration this
  // write inherits the origin of whatever tripped it, so a slow op recorded
  // inside a `sub` load would ride the interactive lane and compete for the
  // reserved connections with the very human it is measuring. Concurrent
  // slow_ops upserts serialize for seconds on this row lock — the observability
  // subsystem amplifying the outage it records. Suppression ("don't record") and
  // the lane ("isn't human-blocking") are separate axes; both apply here. See
  // research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.
  let snapshot!: ContentionSnapshot;
  await runInBackgroundLane(() =>
    runWithoutProfiling(async () => {
      // Capture the box state at the instant this batch tripped. Cached (≤1s) so a
      // storm of slow ops collapses onto one read; inside runWithoutProfiling so
      // its own pg query never re-feeds this recorder. The await MUST stay inside
      // the suppression scope (same reason as the transaction below).
      snapshot = await getContentionSnapshot();

      // The await MUST run inside the suppression scope. A bare `() => db…`
      // returns the lazy query unexecuted, so its execution (and the acquire +
      // query spans the pool wrapper records) would run after the ALS scope exits
      // — defeating suppression and re-opening the self-feedback loop. The same
      // hazard applies to the enclosing lane scope: an escaped await would take
      // its pool connection outside the background declaration. That is why the
      // per-item loop lives INSIDE this transaction callback rather than the
      // transaction living inside a per-item loop.
      await db.transaction(async (tx) => {
        for (const input of admitted) {
          await upsertSlowOpIn(tx, input, input.occurredAt!, snapshot);
        }
      });
    }),
  );

  for (const input of admitted) {
    const {
      operationKind,
      operation,
      durationMs,
      thresholdMs,
      source,
      transportColdStart,
      transportWaitMs,
      traceId,
    } = input;

    // Dual-write a slim marker for the health-monitor overlay (one line per
    // recorded slow op). The snapshot was captured inside the suppression scope
    // above; reuse it so the marker shares the box state the aggregate recorded.
    markerChannel.publish(
      JSON.stringify({
        atTime: input.occurredAt!,
        durationMs,
        operationKind,
        operation,
        loadAvg1: snapshot.loadAvg1,
        cpuCount: snapshot.cpuCount,
      } satisfies SlowOpMarker),
    );

    // Fire-and-forget the per-operation report. The fingerprint keys on
    // (operationKind, operation), so each distinct slow op gets its own report; the
    // message reflects this op's latest tripping duration.
    const durationRounded = Math.round(durationMs);
    void recordReport({
      kind: "slow-op",
      source,
      data: {
        operationKind,
        operation,
        durationMs,
        thresholdMs,
        // Optional cold-start attribution — surfaced in the report title/desc.
        ...(transportColdStart !== undefined ? { transportColdStart } : {}),
        ...(transportWaitMs !== undefined ? { transportWaitMs } : {}),
        // Optional link to the coherent-instant trace captured for this trip.
        ...(traceId !== undefined ? { traceId } : {}),
      },
      message: `${operationKind} ${operation} took ${durationRounded}ms (threshold ${thresholdMs}ms)`,
    });
  }
}

/**
 * The transaction handle `db.transaction(cb)` hands its callback. Derived from
 * the call itself rather than named from drizzle's internals, so it tracks the
 * driver's own type.
 */
type SlowOpTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The durable upsert half of recordSlowOp, db-parametrized so the DB-backed
// suite can drive the SQL semantics (greatest/least timestamps, the
// newest-occurrence guards, ring ordering) against a throwaway Postgres — the
// session-chain `recordSessionId(…, conn)` precedent. Opens its OWN transaction
// around one item, so a single-item caller keeps exactly the semantics it had.
// Production callers go through recordSlowOpBatch, which owns the shed gate,
// the lane + profiling-suppression scopes, the ONE batch transaction, the
// marker dual-write, and the report.
export async function upsertSlowOp(
  input: RecordSlowOpInput,
  occurredAt: Date,
  snapshot: ContentionSnapshot,
  conn: NodePgDatabase = db,
): Promise<void> {
  await conn.transaction(async (tx) => {
    await upsertSlowOpIn(tx, input, occurredAt, snapshot);
  });
}

// The body: one item's upsert against an ALREADY-OPEN transaction. The row lock
// the onConflictDoUpdate takes is what makes the callers/waits/samples
// read-modify-write below race-tolerant, so every caller must supply a
// transaction — a batch shares one across its items, a lone item gets its own
// from the wrapper above.
export async function upsertSlowOpIn(
  tx: SlowOpTx,
  input: RecordSlowOpInput,
  occurredAt: Date,
  snapshot: ContentionSnapshot,
): Promise<void> {
  const {
    operationKind,
    operation,
    durationMs,
    thresholdMs,
    caller,
    waits,
    traceId,
    detail,
  } = input;
  const worktree = runtimeNamespace();

  // `occurredAt` is the trip instant, which under duress-shed replay is
  // EARLIER than now and may be older than what the row already recorded. The
  // timestamps take greatest/least so replay can never regress them, and the
  // last-* attribution (lastMs / thresholdMs) only applies when this
  // occurrence is at least as new as the row's last_seen_at — ON CONFLICT SET
  // expressions all read the PRE-update row, so both guards see the same
  // last_seen_at consistently.
  const isNewest = sql`${occurredAt} >= ${_slowOps.lastSeenAt}`;
  const [row] = await tx
    .insert(_slowOps)
    .values({
      worktree,
      operationKind,
      operation,
      count: 1,
      totalMs: durationMs,
      maxMs: durationMs,
      lastMs: durationMs,
      thresholdMs,
      callers: [],
      firstSeenAt: occurredAt,
      lastSeenAt: occurredAt,
    })
    .onConflictDoUpdate({
      target: [_slowOps.operationKind, _slowOps.operation, _slowOps.worktree],
      set: {
        count: sql`${_slowOps.count} + 1`,
        totalMs: sql`${_slowOps.totalMs} + ${durationMs}`,
        maxMs: sql`greatest(${_slowOps.maxMs}, ${durationMs})`,
        lastMs: sql`case when ${isNewest} then ${durationMs} else ${_slowOps.lastMs} end`,
        thresholdMs: sql`case when ${isNewest} then ${thresholdMs} else ${_slowOps.thresholdMs} end`,
        firstSeenAt: sql`least(${_slowOps.firstSeenAt}, ${occurredAt})`,
        lastSeenAt: sql`greatest(${_slowOps.lastSeenAt}, ${occurredAt})`,
      },
    })
    .returning();

  if (!row) throw new Error("recordSlowOp: upsert returned no row");

  // A second read-modify-write within the same row-locked transaction so
  // both ring merges stay race-safe. recentSamples is ALWAYS updated (every
  // slow op gets a contention sample); callers is merged additionally only
  // when a caller is known (page-load passes null).
  const callers = caller
    ? mergeCaller(row.callers, caller, durationMs)
    : row.callers;
  const nextWaits = waits ? mergeWaits(row.waits, waits) : row.waits;
  const recentSamples = mergeSample(
    row.recentSamples,
    snapshot,
    durationMs,
    traceId,
    occurredAt,
    detail,
  );
  const variants =
    detail?.variant !== undefined
      ? mergeVariant(row.variants, detail.variant, durationMs)
      : row.variants;
  const measures = detail?.measures
    ? mergeMeasures(row.measures, detail.measures)
    : row.measures;
  await tx
    .update(_slowOps)
    .set({ callers, waits: nextWaits, recentSamples, variants, measures })
    .where(eq(_slowOps.id, row.id));
}
