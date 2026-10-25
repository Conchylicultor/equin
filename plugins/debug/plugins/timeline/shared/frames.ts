import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TimelineEventSchema, TimelineSourceSchema } from "../core";

// ---------------------------------------------------------------------------
// NDJSON frame contract for GET /api/debug/timeline — the A3 (server) ↔ A4
// (web) boundary. Mirrors the slow-ops cluster tab's streamed shape: a
// determinate `{ total }` first, per-(source, worktree) chunks as they
// resolve, downsampled health series frames, then `{ end: true }`. One broken
// fork = one `ok: false` chunk, never a blank view.
// ---------------------------------------------------------------------------

// PULL, user-triggered (Refresh button) — never live/polled. Streamed as
// NDJSON (no `response` schema); the client reads it with readNdjson and
// parses each frame against TimelineFrameSchema.
export const TimelineQuerySchema = z.object({
  fromMs: z.coerce.number().finite().positive(), // wall-clock epoch ms
  toMs: z.coerce.number().finite().positive(), // wall-clock epoch ms; > fromMs
});
export const getTimeline = defineEndpoint({
  route: "GET /api/debug/timeline",
  query: TimelineQuerySchema,
});

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
  samples: z.array(TimelineHealthPointSchema),
});
export type TimelineHealthFrame = z.infer<typeof TimelineHealthFrameSchema>;

// Every line of the stream is exactly one of these. `{ error }` is the
// ndjsonResponse auto-frame for an unexpected producer throw (whole-stream
// failure, distinct from a per-chunk `ok: false`).
export const TimelineFrameSchema = z.union([
  z.object({ total: z.number() }), // planned chunk count, emitted first
  z.object({ chunk: TimelineChunkSchema }),
  z.object({ health: TimelineHealthFrameSchema }),
  z.object({ end: z.literal(true) }),
  z.object({ error: z.string() }),
]);
export type TimelineFrame = z.infer<typeof TimelineFrameSchema>;
