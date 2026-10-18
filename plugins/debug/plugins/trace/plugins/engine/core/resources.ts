import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { tracesEntityRef } from "./fields";

/**
 * One trace's list-row metadata — NO snapshot blob, so the list stays cheap even
 * though a snapshot is tens of KB. `wallTime` (the ISO trip anchor, the
 * interval END) and `windowSpanMs` (`atMs − windowStartMs`, the interval width)
 * are two scalar extractions off the unprojected snapshot, for read-side
 * incident grouping.
 */
const TRACE_LIST_CARRIED = {
  wallTime: textField(),
  windowSpanMs: floatField(),
};

/**
 * The recent slow-event traces (`traces`), newest first — the Slow Events list
 * and the detail pane's "Also in this window" strip. A 200-row window (the old
 * list endpoint's cap). `traces` is fed by an in-process change producer (the
 * engine's `tracesProducer`, coalesced to one flush per 2 s), so a new trace or
 * the 7-day sweep reaches an open list without a trigger on a table written
 * exactly when the system is slow.
 */
export const traceEvents = liveCollection("debug.traces", {
  from: tracesEntityRef,
  pick: ["createdAt", "triggerKind", "triggerLabel", "durationMs"],
  carry: {
    pick: ["id", "worktree", "thresholdMs"],
    fields: TRACE_LIST_CARRIED,
  },
  id: "id",
  sortable: ["createdAt", "durationMs"],
  default: { orderBy: [["createdAt", "desc"]], limit: 200 },
  maxLimit: 500,
});

/** One trace's list row: its metadata, no snapshot blob. */
export type TraceListItem =
  typeof traceEvents extends LiveRowsCollection<infer R> ? R : never;

/**
 * One trace with its full snapshot, read by id (`useLiveRow`) for the detail
 * Gantt: a lookup-only collection over the same table, so `found: false` is
 * "no such trace" (an unknown id, or one the sweep removed).
 */
export const traceById = liveCollection("debug.trace", {
  from: tracesEntityRef,
  carry: {
    pick: [
      "id",
      "worktree",
      "triggerKind",
      "triggerLabel",
      "durationMs",
      "thresholdMs",
      "snapshot",
      "createdAt",
    ],
  },
  id: "id",
});
