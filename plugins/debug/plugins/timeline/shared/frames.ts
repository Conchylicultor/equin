import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { TimelineEventSchema, TimelineSourceSchema } from "../core";

// ---------------------------------------------------------------------------
// The timeline producer's frame vocabulary (server/internal/produce.ts): a
// determinate `{ total }` first, per-(source, worktree) chunks as they
// resolve, downsampled health series frames, then `{ end: true }`. One broken
// fork = one `ok: false` chunk, never a blank view. The web tab reads them
// folded into the `debug.timeline.scan` value (`./scan.ts`); the get_timeline
// MCP tool collects them into a text report.
// ---------------------------------------------------------------------------

// One fan-out unit's result: a (source, worktree) cell. `worktree` is the
// fork DB name for DB-backed sources — fork DB names ARE worktree slugs (the
// main DB is MAIN_WORKTREE_NAME), the same identity mapping the
// cluster tab uses — and the worktree log-dir name for disk-backed sources.
export const TimelineChunkSchema = z.discriminatedUnion("ok", [
  z.object({
    source: TimelineSourceSchema,
    worktree: z.string(),
    ok: z.literal(true),
    events: z.array(TimelineEventSchema),
  }),
  // Loud-but-resilient: a saturated / dropped / old-schema fork surfaces as an
  // error cell in the UI instead of blanking the whole timeline.
  z.object({
    source: TimelineSourceSchema,
    worktree: z.string(),
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type TimelineChunk = z.infer<typeof TimelineChunkSchema>;

// The health lane whose points are host vitals rather than backend loop lag.
export const HOST_LANE = "host";

// One downsampled health-series point (≤ ~500 per worktree per window,
// bucket-max so spikes survive). Backend lanes carry the event-loop fields
// (p99Ms required in practice); the HOST_LANE lane carries loadAvg1 + swap
// (swap-in + swap-out pages/sec) plus the macOS memory-compressor channel.
// The lane name discriminates.
export const TimelineHealthPointSchema = z.object({
  atMs: z.number(), // wall-clock epoch ms
  p99Ms: z.number().optional(), // backend event-loop p99 (ms)
  maxMs: z.number().optional(), // backend event-loop max (ms)
  physMb: z.number().optional(), // backend phys_footprint (MB)
  loadAvg1: z.number().optional(), // host lane only
  swap: z.number().optional(), // host lane only: swap-in+out pages/sec
  decompPerSec: z.number().optional(), // host lane only: compressor decompressions/sec
  compPerSec: z.number().optional(), // host lane only: compressor compressions/sec
  compressorMb: z.number().optional(), // host lane only: compressor pool size
  // The sample followed a wall-clock jump (machine sleep) of this many ms —
  // its metrics span the suspend, so it contributes no heat severity and
  // classifies the preceding gap as a "sleep" dark segment (heat.ts).
  wallJumpMs: z.number().optional(),
});
export type TimelineHealthPoint = z.infer<typeof TimelineHealthPointSchema>;

export const TimelineHealthFrameSchema = z.object({
  worktree: z.string(), // backend lane name, or HOST_LANE
  samples: wholeList(TimelineHealthPointSchema, {
    reason:
      "one lane's series downsampled to ≤ 500 buckets, plus the few sleep-wake points kept beside them",
  }),
});
export type TimelineHealthFrame = z.infer<typeof TimelineHealthFrameSchema>;

// Every frame the producer emits is exactly one of these.
export type TimelineFrame =
  | { total: number } // planned chunk count, emitted first
  | { chunk: TimelineChunk }
  | { health: TimelineHealthFrame }
  | { end: true };
