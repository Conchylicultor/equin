import { index, uniqueIndex } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
  defaultRandom,
} from "@plugins/infra/plugins/entities/server";
import { slowOpCallerFields, slowOpFields } from "../../core";

// Durable, deduped slow-operation aggregate: the persisted analogue of the
// runtime-profiler's in-memory `Aggregate`, gated to spans that exceeded their
// configured threshold. One row per (operationKind, operation, worktree);
// every batch of threshold-exceeding occurrences upserts onto its row in ONE
// statement (`recordSlowOpBatch`), merging counters and the bounded JSON lists
// (waits, variants, measures, recentSamples) in SQL. Who issued the op lives
// in `slow_op_callers` below.
//
// The table + the `SlowOp` wire schema both derive from the single
// `slowOpFields` record (core), so a column/schema drift is unrepresentable.
const slowOps = defineEntity("slow_ops", slowOpFields, {
  primaryKey: "id",
  columns: {
    id: { default: defaultRandom() },
    count: { default: 0 },
    totalMs: { default: 0 },
    maxMs: { default: 0 },
    lastMs: { default: 0 },
    thresholdMs: { default: 0 },
    waits: { default: {} },
    variants: { default: [] },
    measures: { default: {} },
    recentSamples: { default: [] },
    firstSeenAt: { default: defaultNow() },
    lastSeenAt: { default: defaultNow() },
  },
  indexes: (t) => [
    uniqueIndex("slow_ops_kind_op_worktree_idx").on(
      t.operationKind,
      t.operation,
      t.worktree,
    ),
    // The list's default order and its keyset pages.
    index("slow_ops_total_ms_idx").on(t.totalMs.desc(), t.id),
    // The "Last seen" sort and the 30-day retention sweep.
    index("slow_ops_last_seen_at_idx").on(t.lastSeenAt.desc(), t.id),
  ],
});

// drizzle-kit schema-glob discovery. Name kept so consumers don't churn.
export const _slowOps = slowOps.table;

// Who issued each slow op: one row per (op key, caller), additive counters.
// Keyed by the op's text key rather than `slow_ops.id` — the recorder upserts
// it without looking the op up, and the detail's window filters it on text
// columns. No foreign key: a cascade would delete around the change producer;
// the 30-day retention sweep on `last_seen_at` removes a caller no later than
// its op (every caller occurrence also bumps the op's `last_seen_at`).
const slowOpCallers = defineEntity("slow_op_callers", slowOpCallerFields, {
  primaryKey: "id",
  columns: {
    id: { default: defaultRandom() },
    count: { default: 0 },
    totalMs: { default: 0 },
    maxMs: { default: 0 },
    firstSeenAt: { default: defaultNow() },
    lastSeenAt: { default: defaultNow() },
  },
  indexes: (t) => [
    uniqueIndex("slow_op_callers_key_idx").on(
      t.operationKind,
      t.operation,
      t.worktree,
      t.callerKind,
      t.callerLabel,
    ),
    // The detail's window: one op's callers by total time, keyset-paged.
    index("slow_op_callers_op_total_ms_idx").on(
      t.operationKind,
      t.operation,
      t.totalMs.desc(),
      t.id,
    ),
    index("slow_op_callers_last_seen_at_idx").on(t.lastSeenAt),
  ],
});

export const _slowOpCallers = slowOpCallers.table;
