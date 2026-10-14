import type {
  SpanDetail,
  WaitBreakdown,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { ContentionSnapshot } from "@plugins/infra/plugins/host/plugins/contention/server";
import type {
  SlowOpMeasures,
  SlowOpSample,
  VariantBreakdown,
} from "../../core";
import type { RecordSlowOpInput } from "./input";
import { mergeMeasures, mergeVariant } from "./merge-detail";

// The batch fold: one admitted batch → one `slow_ops` row per op and one
// `slow_op_callers` row per (op, caller), so the batch is written as ONE
// upsert per table (Postgres refuses an ON CONFLICT that touches a row twice
// in one statement). Folding merges and drops nothing: folding a batch and
// then merging it onto the stored row (merge-sql.ts) equals applying its
// items one by one — the property the suite checks — for every counter,
// time, wait, sample, measure and caller. The one exception is WHICH variant
// stays named: the fold caps a batch's own variants (it must — a batch that
// creates its row is stored as given), so a batch with more than VARIANT_CAP
// distinct variants of one op can fold one the stored row names into
// "(other)". Totals stay exact; the per-item merge was order-dependent there
// too (a folded variant that recurs re-enters with only its new occurrence).

/** One occurrence as the fold reads it: the input plus its trip instant. */
export interface FoldItem {
  input: RecordSlowOpInput;
  occurredAt: Date;
}

/** One op's folded values — exactly the columns its upsert writes. */
export interface SlowOpRowValues {
  worktree: string;
  operationKind: string;
  operation: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  thresholdMs: number;
  waits: WaitBreakdown;
  recentSamples: SlowOpSample[];
  variants: VariantBreakdown[];
  measures: SlowOpMeasures;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** One (op, caller)'s folded counters. */
export interface SlowOpCallerValues {
  worktree: string;
  operationKind: string;
  operation: string;
  callerKind: string;
  callerLabel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface FoldedBatch {
  ops: SlowOpRowValues[];
  callers: SlowOpCallerValues[];
}

// Sum an incoming per-layer wait map into the existing one (layer → total ms).
export function mergeWaits(
  existing: WaitBreakdown,
  incoming: WaitBreakdown,
): WaitBreakdown {
  const next: WaitBreakdown = { ...existing };
  for (const layer in incoming) {
    next[layer] = (next[layer] ?? 0) + incoming[layer]!;
  }
  return next;
}

// Insert a new contention sample and cap the ring at the newest 10. Each
// sample is a distinct point-in-time capture, stamped with the trip's true
// `occurredAt`. Sorted newest-first by atTime (not prepend order): a
// duress-shed item replays after the episode with an in-freeze occurredAt, so
// arrival order is not time order. A tie keeps the newer arrival first — the
// order merge-sql's ring merge reproduces.
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

// A stable sort key for a row's lock order: two backends writing overlapping
// batches during a hot swap take each row lock in the same order, so they
// cannot deadlock.
const compareKeys = (a: readonly string[], b: readonly string[]): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
};

/**
 * Fold `items` (in arrival order) into one row per op and one per (op,
 * caller), each list sorted by key. Every item counts on its op; an item with
 * a caller also counts on that caller's row.
 */
export function foldSlowOpBatch(
  items: readonly FoldItem[],
  snapshot: ContentionSnapshot,
  worktree: string,
): FoldedBatch {
  const ops = new Map<string, SlowOpRowValues>();
  const callers = new Map<string, SlowOpCallerValues>();

  for (const { input, occurredAt } of items) {
    const { operationKind, operation, durationMs, thresholdMs } = input;
    const opKey = JSON.stringify([operationKind, operation]);
    let op = ops.get(opKey);
    if (!op) {
      op = {
        worktree,
        operationKind,
        operation,
        count: 0,
        totalMs: 0,
        maxMs: durationMs,
        lastMs: durationMs,
        thresholdMs,
        waits: {},
        recentSamples: [],
        variants: [],
        measures: {},
        firstSeenAt: occurredAt,
        lastSeenAt: occurredAt,
      };
      ops.set(opKey, op);
    }
    op.count += 1;
    op.totalMs += durationMs;
    op.maxMs = Math.max(op.maxMs, durationMs);
    // The newest occurrence's attribution wins; a tie goes to the later
    // arrival — the same rule the upsert applies against the stored row.
    if (occurredAt.getTime() >= op.lastSeenAt.getTime()) {
      op.lastMs = durationMs;
      op.thresholdMs = thresholdMs;
      op.lastSeenAt = occurredAt;
    }
    if (occurredAt.getTime() < op.firstSeenAt.getTime()) {
      op.firstSeenAt = occurredAt;
    }
    if (input.waits) op.waits = mergeWaits(op.waits, input.waits);
    op.recentSamples = mergeSample(
      op.recentSamples,
      snapshot,
      durationMs,
      input.traceId,
      occurredAt,
      input.detail,
    );
    if (input.detail?.variant !== undefined) {
      op.variants = mergeVariant(op.variants, input.detail.variant, durationMs);
    }
    if (input.detail?.measures) {
      op.measures = mergeMeasures(op.measures, input.detail.measures);
    }

    const caller = input.caller;
    if (!caller) continue;
    const callerKey = JSON.stringify([
      operationKind,
      operation,
      caller.kind,
      caller.label,
    ]);
    const row = callers.get(callerKey);
    if (!row) {
      callers.set(callerKey, {
        worktree,
        operationKind,
        operation,
        callerKind: caller.kind,
        callerLabel: caller.label,
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
        firstSeenAt: occurredAt,
        lastSeenAt: occurredAt,
      });
      continue;
    }
    row.count += 1;
    row.totalMs += durationMs;
    row.maxMs = Math.max(row.maxMs, durationMs);
    if (occurredAt.getTime() < row.firstSeenAt.getTime()) {
      row.firstSeenAt = occurredAt;
    }
    if (occurredAt.getTime() > row.lastSeenAt.getTime()) {
      row.lastSeenAt = occurredAt;
    }
  }

  return {
    ops: [...ops.values()].sort((a, b) =>
      compareKeys(
        [a.operationKind, a.operation],
        [b.operationKind, b.operation],
      ),
    ),
    callers: [...callers.values()].sort((a, b) =>
      compareKeys(
        [a.operationKind, a.operation, a.callerKind, a.callerLabel],
        [b.operationKind, b.operation, b.callerKind, b.callerLabel],
      ),
    ),
  };
}
