import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { TraceSchema } from "./fields";

/**
 * One trace's list-row metadata — NO snapshot blob, so the list stays cheap even
 * though a snapshot is tens of KB. `wallTime` (the ISO trip anchor, the
 * interval END) and `windowSpanMs` (`atMs − windowStartMs`, the interval width)
 * are two scalar extractions off the unprojected snapshot, for read-side
 * incident grouping.
 */
export const TraceListItemSchema = z.object({
  id: z.string(),
  worktree: z.string(),
  triggerKind: z.string(),
  triggerLabel: z.string(),
  durationMs: z.number(),
  thresholdMs: z.number(),
  createdAt: z.coerce.date(),
  wallTime: z.string(),
  windowSpanMs: z.number(),
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
  row: TraceListItemSchema,
  id: "id",
  filterable: { triggerKind: liveText(), createdAt: liveInstant() },
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
  row: TraceSchema,
  id: "id",
});
