import { z } from "zod";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";

// ---------------------------------------------------------------------------
// The closed, normalized wire model of the cross-worktree timeline.
//
// Wall-clock epoch ms is the ONLY clock on the wire: profiler-clock values
// (performance.now domain) are incomparable across backends, so every source
// converts to wall-clock server-side at extraction and nothing downstream ever
// sees a profiler timestamp. See
// research/2026-07-10-global-congestion-observability.md (Phase A).
//
// This is a CLOSED list (closed-list rule): the seven sources are enumerable
// today and the fan-out mechanics are timeline-owned. Revisit as a slot only
// if a non-debug plugin ever needs to feed the timeline.
// ---------------------------------------------------------------------------

export const TIMELINE_SOURCES = [
  "trace",
  "slow-op",
  "report",
  "build",
  "boot",
  "duress",
  "health",
] as const;
export const TimelineSourceSchema = z.enum(TIMELINE_SOURCES);
export type TimelineSource = z.infer<typeof TimelineSourceSchema>;

export const TimelineSeveritySchema = z.enum(["info", "warning", "error"]);
export type TimelineSeverity = z.infer<typeof TimelineSeveritySchema>;

// One normalized timeline event. A point event has startMs === endMs.
//
// `health` is listed in TimelineSource for completeness but never yields
// TimelineEvents — health rides the stream as downsampled series frames (a
// per-lane heat strip, not discrete bars); see shared/frames.ts. `duress`
// events are host-global (worktree = the "host" lane) and render as
// cross-lane bands rather than per-worktree bars.
export const TimelineEventSchema = z.object({
  id: z.string(),
  source: TimelineSourceSchema,
  worktree: z.string(),
  startMs: z.number(), // wall-clock epoch ms
  endMs: z.number(), // wall-clock epoch ms; >= startMs
  label: z.string(),
  severity: TimelineSeveritySchema,
  // Deep-link to the trace detail pane when the source row carries one.
  traceId: z.string().optional(),
  // Source-specific extras for the detail strip. Opaque to the wire model.
  detail: wholeRecord(z.unknown(), {
    reason: "one event's few source-specific fields, written by its extractor",
  }),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
