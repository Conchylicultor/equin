import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  SLOW_OP_LIST_CARRIED,
  SLOW_OP_LIST_OWN,
  slowOpCallersEntityRef,
  slowOpsEntityRef,
} from "./schema";

/**
 * The Slow Ops pane's ranked list: this worktree's `slow_ops` aggregates, a
 * scroll window (100 rows a page) ranked by total time. Slim rows — counters
 * only, no JSON list — so a page is a few KB. `slow_ops` is fed by the
 * recorder's in-process change producer (coalesced to one flush per 2 s), so
 * a new slow occurrence reaches an open list without a per-write cascade.
 */
export const slowOpsList = liveCollection("slow-ops.ops", {
  from: slowOpsEntityRef,
  pick: [
    "operationKind",
    "operation",
    "count",
    "totalMs",
    "maxMs",
    "lastMs",
    "lastSeenAt",
  ],
  fields: SLOW_OP_LIST_OWN,
  carry: {
    pick: ["id", "worktree", "thresholdMs", "firstSeenAt"],
    fields: SLOW_OP_LIST_CARRIED,
  },
  id: "id",
  sortable: ["totalMs", "count", "maxMs", "lastMs", "waitMs", "lastSeenAt"],
  default: { orderBy: [["totalMs", "desc"]], limit: 100 },
  maxLimit: 500,
});

/** One op as the ranked list reads it: the counters only, plus the derived `waitMs` and `lastTraceId`. */
export type SlowOpListRow =
  typeof slowOpsList extends LiveRowsCollection<infer R> ? R : never;

/**
 * One op with its JSON lists (waits, variants, measures, recent samples), read
 * by id (`useLiveRow`) for the detail pane: a lookup-only collection over the
 * same table, so `found: false` is "no such op" (an unknown id, or one the
 * 30-day sweep removed).
 */
export const slowOpById = liveCollection("slow-ops.op", {
  from: slowOpsEntityRef,
  carry: {
    pick: [
      "id",
      "worktree",
      "operationKind",
      "operation",
      "count",
      "totalMs",
      "maxMs",
      "lastMs",
      "thresholdMs",
      "waits",
      "variants",
      "measures",
      "recentSamples",
      "firstSeenAt",
      "lastSeenAt",
    ],
  },
  id: "id",
});

/**
 * Who issued slow ops — one row per (op, caller) from `slow_op_callers` — read
 * scoped to one op (`operationKind` + `operation`) by the detail pane, ranked
 * by total time and paged. Every caller keeps its own row: nothing is folded.
 */
export const slowOpCallers = liveCollection("slow-ops.callers", {
  from: slowOpCallersEntityRef,
  pick: [
    "operationKind",
    "operation",
    "callerKind",
    "callerLabel",
    "count",
    "totalMs",
    "maxMs",
    "lastSeenAt",
  ],
  carry: { pick: ["id", "worktree", "firstSeenAt"] },
  id: "id",
  sortable: ["totalMs", "count", "maxMs", "lastSeenAt"],
  default: { orderBy: [["totalMs", "desc"]], limit: 50 },
  maxLimit: 500,
});

/** One caller of a slow op, as the callers list reads it. */
export type SlowOpCallerListRow =
  typeof slowOpCallers extends LiveRowsCollection<infer R> ? R : never;
