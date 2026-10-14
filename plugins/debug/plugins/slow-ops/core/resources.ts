import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  SlowOpCallerSchema,
  SlowOpDetailSchema,
  SlowOpListRowSchema,
} from "./schema";

/**
 * The Slow Ops pane's ranked list: this worktree's `slow_ops` aggregates, a
 * scroll window (100 rows a page) ranked by total time. Slim rows — counters
 * only, no JSON list — so a page is a few KB. `slow_ops` is fed by the
 * recorder's in-process change producer (coalesced to one flush per 2 s), so
 * a new slow occurrence reaches an open list without a per-write cascade.
 */
export const slowOpsList = liveCollection("slow-ops.ops", {
  row: SlowOpListRowSchema,
  id: "id",
  filterable: {
    operationKind: liveText(),
    operation: liveText(),
    count: liveNumber(),
    totalMs: liveNumber(),
    lastSeenAt: liveInstant(),
  },
  sortable: ["totalMs", "count", "maxMs", "lastMs", "waitMs", "lastSeenAt"],
  default: { orderBy: [["totalMs", "desc"]], limit: 100 },
  maxLimit: 500,
  scroll: true,
});

/**
 * One op with its JSON lists (waits, variants, measures, recent samples), read
 * by id (`useLiveRow`) for the detail pane: a lookup-only collection over the
 * same table, so `found: false` is "no such op" (an unknown id, or one the
 * 30-day sweep removed).
 */
export const slowOpById = liveCollection("slow-ops.op", {
  row: SlowOpDetailSchema,
  id: "id",
});

/**
 * Who issued slow ops — one row per (op, caller) from `slow_op_callers` — read
 * scoped to one op (`operationKind` + `operation`) by the detail pane, ranked
 * by total time and paged. Every caller keeps its own row: nothing is folded.
 */
export const slowOpCallers = liveCollection("slow-ops.callers", {
  row: SlowOpCallerSchema,
  id: "id",
  filterable: {
    operationKind: liveText(),
    operation: liveText(),
    callerKind: liveText(),
    callerLabel: liveText(),
  },
  sortable: ["totalMs", "count", "maxMs", "lastSeenAt"],
  default: { orderBy: [["totalMs", "desc"]], limit: 50 },
  maxLimit: 500,
  scroll: true,
});
