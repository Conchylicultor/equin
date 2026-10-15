import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  SLOW_OP_CALLER_CARRIED,
  SLOW_OP_CALLER_LISTED,
  SLOW_OP_LIST_CARRIED,
  SLOW_OP_LIST_LISTED,
  slowOpFields,
} from "./schema";

/**
 * The Slow Ops pane's ranked list: this worktree's `slow_ops` aggregates, a
 * scroll window (100 rows a page) ranked by total time. Slim rows — counters
 * only, no JSON list — so a page is a few KB. `slow_ops` is fed by the
 * recorder's in-process change producer (coalesced to one flush per 2 s), so
 * a new slow occurrence reaches an open list without a per-write cascade.
 */
export const slowOpsList = liveCollection("slow-ops.ops", {
  fields: SLOW_OP_LIST_LISTED,
  carry: { fields: SLOW_OP_LIST_CARRIED },
  id: "id",
  sortable: ["totalMs", "count", "maxMs", "lastMs", "waitMs", "lastSeenAt"],
  default: { orderBy: [["totalMs", "desc"]], limit: 100 },
  maxLimit: 500,
});

/**
 * One op with its JSON lists (waits, variants, measures, recent samples), read
 * by id (`useLiveRow`) for the detail pane: a lookup-only collection over the
 * same table, so `found: false` is "no such op" (an unknown id, or one the
 * 30-day sweep removed).
 */
export const slowOpById = liveCollection("slow-ops.op", {
  carry: { fields: slowOpFields },
  id: "id",
});

/**
 * Who issued slow ops — one row per (op, caller) from `slow_op_callers` — read
 * scoped to one op (`operationKind` + `operation`) by the detail pane, ranked
 * by total time and paged. Every caller keeps its own row: nothing is folded.
 */
export const slowOpCallers = liveCollection("slow-ops.callers", {
  fields: SLOW_OP_CALLER_LISTED,
  carry: { fields: SLOW_OP_CALLER_CARRIED },
  id: "id",
  sortable: ["totalMs", "count", "maxMs", "lastSeenAt"],
  default: { orderBy: [["totalMs", "desc"]], limit: 50 },
  maxLimit: 500,
});
