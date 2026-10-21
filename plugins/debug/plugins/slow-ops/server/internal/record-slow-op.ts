import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { db } from "@plugins/database/server";
import type { ProducerExecutor } from "@plugins/database/plugins/change-feed/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
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
} from "@plugins/infra/plugins/host/plugins/duress/plugins/shed/server";
import type { SlowOpMarker } from "../../core";
import { foldSlowOpBatch, type FoldedBatch, type FoldItem } from "./fold-batch";
import type { RecordSlowOpInput } from "./input";
import { buildCallerUpsert, buildOpUpsert } from "./merge-sql";
import { slowOpCallersProducer, slowOpsProducer } from "./producer";

export type { RecordSlowOpInput } from "./input";

// A slim overlay marker per recorded slow op, dual-written to a durable log
// channel. Mirrors the health sampler's `defineLogSink({ id: "health" })` — each
// worktree backend writes to its own logs/slow-op-markers.jsonl, read from disk by
// the health-monitor endpoint to draw spike lines on the charts. Uncapped (one
// line per slow op), unlike the 10-entry DB recentSamples ring.
const markerChannel = defineLogSink({
  id: "slow-op-markers",
  description:
    "PERF sink: one marker line per recorded slow op, read from disk to draw spike lines on the Debug → Health charts.",
});

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
// merge is order-insensitive, so counts / totals / maxMs stay truthful
// post-flush. Each buffered item carries the `occurredAt`
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
// (operationKind, operation, worktree) and its caller row, and
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
// contention snapshot and ONE upsert per table cover the whole batch.
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
  const admitted: FoldItem[] = [];
  for (const input of inputs) {
    const occurredAt = (input.occurredAt ??= new Date());
    if (!slowOpShed.admit(input).persist) continue;
    admitted.push({ input, occurredAt });
  }
  if (admitted.length === 0) return;

  // Wrapped in runWithoutProfiling: the slow_ops upserts are themselves `db`
  // spans that would otherwise re-feed the slow-op recorder (self-amplifying
  // loop). The suppression ALS propagates through every awaited query inside
  // the callback. The snapshot is hoisted out of the suppression callback so
  // the dual-write markers below can reuse the same captured box state.
  // Assigned inside the scope (the await must stay there); non-null after the
  // callback resolves.
  //
  // Wrapped OUTSIDE that in runInBackgroundLane: without the declaration this
  // write inherits the origin of whatever tripped it, so a slow op recorded
  // inside a `sub` load would ride the interactive lane and compete for the
  // reserved connections with the very human it is measuring. Suppression
  // ("don't record") and the lane ("isn't human-blocking") are separate axes;
  // both apply here. See
  // research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.
  let snapshot!: ContentionSnapshot;
  await runInBackgroundLane(() =>
    runWithoutProfiling(async () => {
      // Capture the box state at the instant this batch tripped. Cached (≤1s) so a
      // storm of slow ops collapses onto one read; inside runWithoutProfiling so
      // its own pg query never re-feeds this recorder. The await MUST stay inside
      // the suppression scope (same reason as the writes below).
      snapshot = await getContentionSnapshot();

      // The awaits MUST run inside the suppression scope. A bare `() => db…`
      // returns the lazy query unexecuted, so its execution (and the acquire +
      // query spans the pool wrapper records) would run after the ALS scope exits
      // — defeating suppression and re-opening the self-feedback loop. The same
      // hazard applies to the enclosing lane scope: an escaped await would take
      // its pool connection outside the background declaration.
      await writeSlowOpRows(
        foldSlowOpBatch(admitted, snapshot, runtimeNamespace()),
      );
    }),
  );

  for (const { input, occurredAt } of admitted) {
    const {
      operationKind,
      operation,
      durationMs,
      thresholdMs,
      source,
      transportColdStart,
      waits,
      traceId,
    } = input;

    // Dual-write a slim marker for the health-monitor overlay (one line per
    // recorded slow op). The snapshot was captured inside the suppression scope
    // above; reuse it so the marker shares the box state the aggregate recorded.
    markerChannel.publish(
      JSON.stringify({
        atTime: occurredAt,
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
        // This trip's per-layer split, so the description can name the layer
        // the time went to (the row's `waits` are cumulative, not this trip's).
        ...(waits !== undefined ? { waits } : {}),
        // Optional link to the coherent-instant trace captured for this trip.
        ...(traceId !== undefined ? { traceId } : {}),
      },
      message: `${operationKind} ${operation} took ${durationRounded}ms (threshold ${thresholdMs}ms)`,
    });
  }
}

// The durable write of a folded batch: ONE upsert per table, each through its
// change producer (which routes the ids it returned to live readers, coalesced
// to one flush per 2 s — see ./producer). Every list merge runs in SQL against
// the row ON CONFLICT locked (merge-sql.ts), so no JS runs under a lock and a
// batch is two autocommit statements however many items it holds — never a
// transaction per item (the 2026-09-02 amplification). The two statements are
// not atomic together: between them a reader can see an op's counters one
// batch ahead of its callers. Executor-parametrized so the DB-backed suite
// drives the SQL merges against a throwaway Postgres.
export async function writeSlowOpRows(
  batch: FoldedBatch,
  executor: ProducerExecutor = db,
): Promise<void> {
  if (batch.ops.length > 0) {
    await slowOpsProducer.mutate(
      executor,
      (q, t) => buildOpUpsert(q, t, batch.ops),
      { latency: "background" },
    );
  }
  if (batch.callers.length > 0) {
    await slowOpCallersProducer.mutate(
      executor,
      (q, t) => buildCallerUpsert(q, t, batch.callers),
      { latency: "background" },
    );
  }
}
