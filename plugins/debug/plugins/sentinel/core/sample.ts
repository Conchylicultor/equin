import { z } from "zod";
import { DiskReadingSchema } from "@plugins/debug/plugins/sentinel/plugins/status-file/core";

// One cluster-vitals sample, emitted into the "cluster" trace ring every
// sentinel tick. `wall` is the wall-clock anchor (Date.now()); the ring's own
// `tMs` is profiler-clock and only joins the containing snapshot's timeline.
//
// Fleet fields are nullable: a gateway or `ps` hiccup must not lose the
// host/pg vitals of the very tick where things are going wrong — the sub-read
// fails into null (and a log line), never the whole sample.
export const ClusterSampleSchema = z.object({
  wall: z.number(),
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  cpuCount: z.number(),
  // Pg fields are nullable: the sentinel worker's dedicated pg client fails
  // into null fields (one reconnect attempt, then a log line) — a pg hiccup
  // must not lose the tick's host/fleet vitals.
  pgActiveBackends: z.number().nullable(),
  pgTotalBackends: z.number().nullable(),
  /** Active-backend counts by pg wait_event_type (IO, LWLock, Lock, ...). */
  pgWaitEvents: z.record(z.string(), z.number()).nullable(),
  pgLocksWaiting: z.number().nullable(),
  /** Per-tick deltas; null on the first tick (no baseline yet). */
  pgBlkReadDeltaMs: z.number().nullable(),
  pgXactCommitDelta: z.number().nullable(),
  /** Gateway view; null when the gateway fetch failed this tick. */
  runningBackends: z.number().nullable(),
  totalActiveConns: z.number().nullable(),
  /** `ps` scan; null when the scan failed this tick. */
  inFlightBuilds: z.number().nullable(),
  /**
   * worktree → latest health-sample event-loop p99 (ms). Refreshed every 3rd
   * tick (a disk scan); intermediate ticks carry the previous rollup.
   */
  backendP99: z.record(z.string(), z.number()),
  // macOS memory-compressor pressure, tail-read from the host sampler's
  // health-host.jsonl (30s freshness guard) — the memory signal the detector
  // was blind to (research/2026-07-11-global-fleet-memory-admission-duress-valve.md,
  // D6). Null when the host line is missing/stale; `.optional()` so pre-cutover
  // persisted ring slices still parse (the monitorOps convention).
  decompressionsPerSec: z.number().nullable().optional(),
  compressorMb: z.number().nullable().optional(),
  freeMemMb: z.number().nullable().optional(),
  /**
   * The home volume's free space and how fast it is falling; null when the
   * statfs failed this tick. Optional so pre-cutover ring slices still parse.
   */
  disk: DiskReadingSchema.nullable().optional(),
});
export type ClusterSample = z.infer<typeof ClusterSampleSchema>;

// The persisted snapshot section is the ring slice itself: RingEvent[] whose
// `data` is a ClusterSample (the engine persists the slice directly — no
// enrich, no captureAtTrip).
export const ClusterSectionSchema = z.array(
  z.object({ tMs: z.number(), data: ClusterSampleSchema }),
);
export type ClusterSection = z.infer<typeof ClusterSectionSchema>;
