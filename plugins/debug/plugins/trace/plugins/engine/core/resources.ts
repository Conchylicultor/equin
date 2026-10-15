import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { traceFields } from "./fields";

/**
 * One trace's list-row metadata — NO snapshot blob, so the list stays cheap even
 * though a snapshot is tens of KB. `wallTime` (the ISO trip anchor, the
 * interval END) and `windowSpanMs` (`atMs − windowStartMs`, the interval width)
 * are two scalar extractions off the unprojected snapshot, for read-side
 * incident grouping.
 */
const TRACE_LIST_LISTED = {
  triggerKind: textField({ label: "Trigger" }),
  createdAt: dateField({ label: "When" }),
};
const TRACE_LIST_CARRIED = {
  id: traceFields.id,
  worktree: traceFields.worktree,
  triggerLabel: traceFields.triggerLabel,
  durationMs: traceFields.durationMs,
  thresholdMs: traceFields.thresholdMs,
  wallTime: textField(),
  windowSpanMs: floatField(),
};
export const TraceListItemSchema = fieldsToZodObject({
  ...TRACE_LIST_CARRIED,
  ...TRACE_LIST_LISTED,
});
export type TraceListItem = z.infer<typeof TraceListItemSchema>;

/**
 * The recent slow-event traces (`traces`), newest first — the Slow Events list
 * and the detail pane's "Also in this window" strip. A 200-row window (the old
 * list endpoint's cap). `traces` is fed by an in-process change producer (the
 * engine's `tracesProducer`, coalesced to one flush per 2 s), so a new trace or
 * the 7-day sweep reaches an open list without a trigger on a table written
 * exactly when the system is slow.
 */
export const traceEvents = liveCollection("debug.traces", {
  fields: TRACE_LIST_LISTED,
  carry: { fields: TRACE_LIST_CARRIED },
  id: "id",
  sortable: ["createdAt", "durationMs"],
  default: { orderBy: [["createdAt", "desc"]], limit: 200 },
  maxLimit: 500,
});

/**
 * One trace with its full snapshot, read by id (`useLiveRow`) for the detail
 * Gantt: a lookup-only collection over the same table, so `found: false` is
 * "no such trace" (an unknown id, or one the sweep removed).
 */
export const traceById = liveCollection("debug.trace", {
  carry: { fields: traceFields },
  id: "id",
});
