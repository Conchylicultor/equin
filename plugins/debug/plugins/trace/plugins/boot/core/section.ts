import { z } from "zod";

// The boot event class's snapshot section (persisted under
// snapshot.events.boot). It is the whole-boot server profile — phase spans +
// memory checkpoints from getProfilingData(), plus the gateway-observed
// readiness wait when the gateway reported one — pre-aggregated by
// debug/boot-monitor and handed in via `trigger.detail`.
//
// CLOCK AXES — the engine clock-domain rule applies twice here:
//   - `wallStartMs` is the ONE wall-clock anchor: epoch ms of process start
//     (Math.round(performance.timeOrigin)), the same pairing key boot-events
//     uses. Every span/checkpoint offset (`startMs`, `atMs`) is relative to it.
//   - The gateway fields are RAW epoch ms (stamped by a different process, so
//     they cannot share the backend's profiler clock); consumers re-anchor them
//     as `value − wallStartMs`. `spawnRequestedAt` precedes process start, so
//     its re-anchored offset is legitimately NEGATIVE.
//   - The section therefore renders on its OWN clock axis, never the trace
//     window's: the boot happened minutes before the monitor's trip instant,
//     so window-relative positioning would be meaningless.
//
// This is the single source of truth for the section shape, shared by:
//   - the boot-monitor producer that builds it (from getProfilingData()),
//   - the server class that validates it,
//   - the web lane that parses it.

// One profiler boot span — mirrors server-core's `Span` (profiler.ts) field for
// field. `phase` stays an open string (not the PhaseId union) so a trace
// persisted by a newer backend that grew a phase still parses everywhere.
export const BootSpanSchema = z.object({
  id: z.string(),
  phase: z.string(),
  plugin: z.string().optional(),
  label: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  physFootprintStartMb: z.number().optional(),
  physFootprintEndMb: z.number().optional(),
});
export type BootSpan = z.infer<typeof BootSpanSchema>;

// A phase-boundary memory checkpoint, trimmed to the fields the lane shows —
// the authoritative per-phase footprint numbers (per-span deltas inside the
// parallel onReady phases overlap and are only directional).
export const BootMemoryCheckpointSchema = z.object({
  label: z.string(),
  atMs: z.number(),
  physFootprintMb: z.number(),
  heapUsedMb: z.number(),
});
export type BootMemoryCheckpoint = z.infer<typeof BootMemoryCheckpointSchema>;

// The gateway-observed side of the boot: spawn request → spawn → readiness, as
// RAW epoch ms plus the readiness-path flags. Every field is optional — the
// gateway and backend version independently (the gateway binary only updates on
// an explicit user-gated recompile), so a partial report from either side of
// the skew must stay valid rather than invalidate the whole section. This same
// schema is the body of boot-monitor's POST /api/boot/gateway-report.
export const BootGatewaySchema = z.object({
  /** Epoch ms the gateway decided to spawn the backend (precedes wallStartMs). */
  spawnRequestedAt: z.number().optional(),
  /** Epoch ms the backend process was spawned. */
  spawnedAt: z.number().optional(),
  /** Epoch ms the gateway observed /api/health/ready go 200. */
  readyObservedAt: z.number().optional(),
  /** The load-adaptive readiness deadline was escalated. */
  escalated: z.boolean().optional(),
  /** The backend responded over HTTP during the wait (vs socket-only signs of life). */
  respondedHTTP: z.boolean().optional(),
  /** The wait was demoted (deprioritized) by the gateway's admission policy. */
  demoted: z.boolean().optional(),
});
export type BootGateway = z.infer<typeof BootGatewaySchema>;

export const BootSectionSchema = z.object({
  // Epoch ms of process start (Math.round(performance.timeOrigin)) — the wall
  // anchor every offset below is relative to, and the boot-events pairing key.
  wallStartMs: z.number(),
  // Profiler total: max span end offset recorded by the mint tick (post-ready
  // work included) — context, not the verdict.
  totalDurationMs: z.number(),
  // Ms from process start to markServerReady() — the number the slow-op trips
  // on. Optional: traces minted before it existed (which tripped on
  // totalDurationMs) still parse.
  timeToReadyMs: z.number().optional(),
  spans: z.array(BootSpanSchema),
  memoryCheckpoints: z.array(BootMemoryCheckpointSchema),
  // Present only when the gateway POSTed its report before the mint tick.
  gateway: BootGatewaySchema.optional(),
});
export type BootSection = z.infer<typeof BootSectionSchema>;
