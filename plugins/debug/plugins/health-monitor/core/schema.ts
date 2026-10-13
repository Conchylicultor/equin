import { z } from "zod";
import { SlowOpMarkerSchema } from "@plugins/debug/plugins/slow-ops/core";

// One per-backend health sample. Every field except `worktree` is a number so
// the wire shape maps cleanly onto recharts series. Event-loop values are
// milliseconds (the perf_hooks histogram reports nanoseconds; the sampler
// divides). Memory values are MB.
export const HealthSampleSchema = z.object({
  sampledAt: z.number(), // Date.now() ms epoch
  worktree: z.string(),
  eventLoopP50Ms: z.number(),
  eventLoopP99Ms: z.number(),
  eventLoopMaxMs: z.number(),
  // Real macOS phys_footprint (MB; rss off-darwin) — replaces the old rssMb,
  // which over-counted ~6× on macOS. Pre-cutover JSONL lines lack this field and
  // are dropped by safeParse (a brief history gap as the rolling window refills).
  physFootprintMb: z.number(),
  // Real macOS ri_resident_size (MB) — pages physically in RAM right now,
  // EXCLUDING pages sitting in the compressor / swap. phys_footprint INCLUDES
  // compressed private pages, so `physFootprintMb − residentMb` ≈ this
  // backend's squeezed-out bytes — the direct paging-victimhood series (see
  // research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md §A2).
  // Read it as a TREND, not an absolute: resident also counts shared/file-backed
  // pages footprint does not charge, so a small unsqueezed process can read
  // resident > footprint (negative difference). The squeeze signal is resident
  // FALLING while footprint holds.
  // NOT `process.memoryUsage().rss`, which over-counts ~6× on macOS (the very
  // reason the old rssMb field was removed). Optional — pre-cutover JSONL lines
  // must still parse, same rationale as `monitorOps` below; absent off-darwin.
  residentMb: z.number().optional(),
  heapUsedMb: z.number(),
  heapTotalMb: z.number(),
  heapGrowthMb: z.number(), // Δ heapUsed vs prior tick; negative = a GC reclaimed
  gcPreciseCount: z.number(), // perf_hooks 'gc' observer; 0 when unsupported (Bun)
  gcPreciseTotalMs: z.number(),
  // Host-wide heavy-read gate queue depth at sample time (callers parked waiting
  // for a slot; 0 = uncontended). Required rather than `.default(0)`, so a line
  // that predates the field is dropped instead of silently reading as
  // uncontended. Pre-cutover JSONL lines lacking this field
  // are dropped by safeParse — a brief history gap as the rolling window refills,
  // exactly as `physFootprintMb` handled its own cutover above.
  heavyReadDepth: z.number(),
  // Monitoring self-cost deltas for this tick, diffed from the runtime
  // profiler's cumulative self-meter: `monitorOps` = outermost
  // runWithoutProfiling scopes that started, `monitorMs` = their summed
  // wall-clock. Everything suppressed is by definition monitoring work, so
  // these are the ONLY visibility into the observability subsystem's own load
  // (its spans are dropped by design). Optional — unlike `heavyReadDepth`,
  // pre-cutover JSONL lines must still parse (the timeline heat strip wants
  // uninterrupted history; a missing value renders as a gap, not a dropped
  // sample). `.optional()` keeps input/output types symmetric, so the
  // downstream `HealthSeries` props stay consistent.
  monitorOps: z.number().optional(),
  monitorMs: z.number().optional(),
  // Present when this tick fired after a wall-clock jump (machine sleep /
  // suspend): the gap in ms since the previous tick. The sampler resets the
  // loop-lag histogram BEFORE reading it on such a tick, so the eventLoop*
  // fields describe an empty post-wake window instead of the suspend (the old
  // behavior painted fake multi-minute stalls after every sleep — see
  // research/2026-07-11-global-observability-freeze-blind-spots.md, Stage 6).
  // Consumers treat a stamped sample as "no measurement this window": the
  // timeline renders the preceding gap as a dark "sleep" segment. Optional —
  // pre-cutover JSONL lines must still parse, same rationale as `monitorOps`.
  wallJumpMs: z.number().optional(),
  // Present when the machine SLEPT during this window, however briefly: the ms
  // asleep, measured exactly as the gap between the OS clock that runs through
  // sleep and the one that pauses (packages/sleep-clock). It catches what
  // `wallJumpMs` cannot — maintenance naps of a few seconds, far under its 50 s
  // bar, which otherwise read as multi-second event-loop stalls (2026-09-20: two
  // unrelated backends filed identical stalls for the same naps). Same contract:
  // the histogram is reset before reading, so a stamped sample is "no measurement
  // this window". Absent off darwin, where sleep cannot be told from a stall.
  sleptMs: z.number().optional(),
});
export type HealthSample = z.infer<typeof HealthSampleSchema>;

// One host-level sample. Sampled only on the main backend (the host is shared).
export const HostSampleSchema = z.object({
  sampledAt: z.number(),
  freeMemMb: z.number(),
  totalMemMb: z.number(),
  usedMemMb: z.number(),
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  loadAvg15: z.number(),
  swapInPagesPerSec: z.number(), // macOS vm_stat Swapins delta; 0 elsewhere
  swapOutPagesPerSec: z.number(),
  // macOS memory-compressor activity (vm_stat Compressions/Decompressions
  // deltas; 0 elsewhere). The pressure channel swap-in is blind to: macOS
  // compresses long before it touches the swapfile, and each decompression is
  // a page fault that blocks the faulting thread synchronously (see
  // research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md,
  // Finding 1). Optional — pre-cutover JSONL lines must still parse, same
  // rationale as `monitorOps` above.
  compressionsPerSec: z.number().optional(),
  decompressionsPerSec: z.number().optional(),
  // Optional like its two compressor siblings — it shipped in the same cutover,
  // and leaving it required made their optionality moot (safeParse dropped the
  // pre-cutover line on this field anyway).
  compressorMb: z.number().optional(),
  // Wall-clock jump (machine sleep) marker — same contract as
  // HealthSampleSchema.wallJumpMs above. On a stamped tick the vm_stat rate
  // deltas are averaged over the true elapsed window (which spans the suspend),
  // not the nominal cadence, so a sleep can never fabricate a rate spike.
  wallJumpMs: z.number().optional(),
});
export type HostSample = z.infer<typeof HostSampleSchema>;

export const HealthSeriesSchema = z.object({
  worktree: z.string(),
  samples: z.array(HealthSampleSchema),
  // Slow-op spikes for this backend, overlaid on its metric charts as
  // severity-colored vertical ReferenceLines on the shared time axis.
  slowOpMarkers: z.array(SlowOpMarkerSchema),
});
export type HealthSeries = z.infer<typeof HealthSeriesSchema>;

// The Health pane's whole read: every worktree's series and the host samples
// over the last `windowMs`, as read from disk at `readAtMs` (epoch ms — the
// "now" a backend's sample age is measured against).
export const HealthDataSchema = z.object({
  series: z.array(HealthSeriesSchema),
  hostSamples: z.array(HostSampleSchema),
  windowMs: z.number(),
  readAtMs: z.number(),
});
export type HealthData = z.infer<typeof HealthDataSchema>;
