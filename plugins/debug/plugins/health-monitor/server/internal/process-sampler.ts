import {
  runtimeNamespace,
  isMain,
} from "@plugins/infra/plugins/runtime-identity/core";
import { join } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  type IntervalHistogram,
} from "node:perf_hooks";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { procMemory } from "@plugins/framework/plugins/server-core/core";
import { heavyReadQueueDepth } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { getSelfMeter } from "@plugins/infra/plugins/runtime-profiler/core";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import type { HealthSample } from "../../core";
import {
  startStallProfiler,
  stopStallProfiler,
  drainAndMaybeDump,
} from "./stall-profiler";
import { detectWallJumpMs } from "./wall-jump";
import {
  createSleepMeter,
  type SleepMeter,
} from "@plugins/packages/plugins/sleep-clock/core";
import { publishSleepReading } from "@plugins/infra/plugins/host/plugins/machine-sleep/server";

// Per-backend health sampler. Installed in the server plugin's `onReady` and
// torn down in `onShutdown`. It samples this process's own event-loop lag, GC
// pressure, and memory every SAMPLE_INTERVAL_MS and appends one JSONL line to
// ~/.singularity/worktrees/<wt>/logs/health.jsonl (durable, read from disk by
// the main backend's pane endpoint).
//
// Why a timer (an in-process interval) and NOT a defineJob / graphile cron task: the sampler is
// the diagnostic instrument FOR a wedged backend. Routing it through the job
// queue (which itself runs on the event loop) would mean a blocked event loop
// silently starves its own health sampler. graphile cron is also 5-field
// (1-minute floor), too coarse for a ~10s cadence. Crucially, the event-loop
// delay histogram accumulates natively in C even while JS is blocked, so a
// *late* tick is itself signal and the recorded `max` still reveals the stall.
// Mirrors jobs/server/internal/stuck-lock-sweeper.ts.

const SAMPLE_INTERVAL_MS = 10_000;
const MAX_FILE_BYTES = 5_000_000; // ~2 days at 10s; tail-trimmed past this

// Arm-on-elevated thresholds for NON-main backends (main is always armed): the
// JSC stall profiler arms the first time a tick observes an elevated event
// loop. Arming is ONE-WAY per process (bun:jsc has no stop — see
// stall-profiler.ts), so this trades "the first stall of a previously-healthy
// backend is missed" for "mostly-idle worktree backends never pay the ~230 Hz
// sampler thread". Stalls under sustained congestion recur, so the evidence
// still lands. Code constants like STALL_THRESHOLD_MS, not config.
const STALL_ARM_P99_MS = 200;
const STALL_ARM_MAX_MS = 1_000;

// A window counts as "the machine slept" from this much sleep. The two OS clocks
// are read a few hundred nanoseconds apart, so an awake window measures a hair
// above zero; 250 ms is far above that and far below the shortest nap seen (5 s).
const SLEPT_MIN_MS = 250;

// Sample observers — the `onSlowSpan` shape. A plugin that wants every sample as
// it is taken (debug/latency-ledger: thread-lag distribution + its minute clock)
// registers here instead of tailing the JSONL. Called at the end of every tick,
// on the sampler's own timer: an observer must be cheap and must not throw.
export type HealthSampleObserver = (sample: HealthSample) => void;
const sampleObservers = new Set<HealthSampleObserver>();
export function onHealthSample(cb: HealthSampleObserver): () => void {
  sampleObservers.add(cb);
  return () => sampleObservers.delete(cb);
}

let histogram: IntervalHistogram | null = null;
// Profiler-invisible: the tick drains the JSC stall profiler and reads the
// profiler's own self-meter, so spanning it would re-feed what it measures.
export const processSamplerTimer = defineTimer({
  name: "health.process-sampler",
  description:
    "Samples this backend's event-loop lag, memory and garbage-collection pressure every 10 seconds into its health log, which Debug → Health reads.",
  everyMs: SAMPLE_INTERVAL_MS,
  profile: "invisible",
  run: tick,
});
// Declared exactly once at module eval (not in start): the sampler can be stopped
// and restarted, and `defineLogSink` throws on a duplicate id. PERF sink.
const channel = defineLogSink({
  id: "health",
  description:
    "PERF sink: per-backend health samples (event-loop lag, GC/heap pressure, phys_footprint), read from disk to draw the Debug → Health charts.",
});
let gcObserver: PerformanceObserver | null = null;
let gcCount = 0;
let gcTotalMs = 0;
let lastHeapUsedBytes = 0;
// Previous tick's reading of the runtime profiler's cumulative monitoring
// self-meter, diffed each tick into the sample's per-tick monitorOps/monitorMs
// deltas (same pattern as lastHeapUsedBytes).
let lastMonitorOps = 0;
let lastMonitorMs = 0;
// Wall-time of the previous tick. A blocked loop fires its tick LATE, so the real
// drain window (and the JSC sample count's denominator) is now - lastTickAt, not
// the nominal interval. Used only while the stall profiler is armed.
let lastTickAt = 0;
// Whether the JSC stall profiler is armed in THIS process: main arms at boot,
// worktree backends arm-on-elevated (one-way — bun:jsc has no stop).
let stallArmed = false;
// Exact machine-sleep measurement between ticks (see SLEPT_MIN_MS).
let sleepMeter: SleepMeter | null = null;

function healthFilePath(): string {
  return join(worktreeDataDir(runtimeNamespace()), "logs", "health.jsonl");
}

// Keep the JSONL bounded without a job: trim to the newest half once it grows
// past the cap. One sync rewrite per growth cycle; statSync is cheap.
function rotateIfNeeded(): void {
  const file = healthFilePath();
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (size <= MAX_FILE_BYTES) return;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  writeFileSync(
    file,
    lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n",
  );
}

function tick(): void {
  if (!histogram) return;
  const now = Date.now();
  // Machine sleep spanned this window: the histogram accumulated the suspend
  // itself (huge max, calm p50 — a fake incident on every consumer). Reset it
  // BEFORE reading so the sample carries an honest empty window, and stamp
  // wallJumpMs so the gap is classifiable downstream. A merely-late tick from
  // a wedged loop stays below the jump factor and keeps its stall evidence.
  const wallJumpMs = detectWallJumpMs(now, lastTickAt, SAMPLE_INTERVAL_MS);
  // …and the naps that heuristic cannot see: any sleep at all in this window,
  // measured from the OS clocks. A nap pollutes the histogram exactly like a long
  // suspend does, so it gets the same treatment.
  const slept = sleepMeter?.read();
  const sleptMs =
    slept?.supported === true && slept.sleptMs >= SLEPT_MIN_MS
      ? slept.sleptMs
      : undefined;
  if (wallJumpMs !== undefined || sleptMs !== undefined) histogram.reset();
  // The machine.sleep live value rides this tick: the sampler is already the
  // periodic observer of this process, so a wake reaches the browser within one
  // SAMPLE_INTERVAL_MS (≤10 s) without a poller of its own (no-polling rule).
  // It pushes only when the reading changed, i.e. after a wake.
  publishSleepReading();
  const mem = process.memoryUsage();
  const meter = getSelfMeter();
  const proc = procMemory();
  const sample: HealthSample = {
    sampledAt: now,
    worktree: runtimeNamespace(),
    eventLoopP50Ms: histogram.percentile(50) / 1e6,
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
    eventLoopMaxMs: histogram.max / 1e6,
    // Real footprint, not rss (rss over-counts ~6× on macOS). Sync FFI call so a
    // wedged event loop never starves it. Falls back to rss off-darwin.
    physFootprintMb: (proc?.physFootprintBytes ?? mem.rss) / 1_048_576,
    // ri_resident_size — physFootprintMb minus this is the squeezed-out series
    // (see the schema comment). Same syscall as physFootprint; absent off-darwin.
    residentMb: proc ? proc.residentSizeBytes / 1_048_576 : undefined,
    heapUsedMb: mem.heapUsed / 1_048_576,
    heapTotalMb: mem.heapTotal / 1_048_576,
    // Δ JS heap since the last tick: a sharp drop is a GC reclaim, a sustained
    // climb is allocation pressure. The GC-pressure proxy on Bun (no precise
    // 'gc' perf entries there); gcPrecise* stay 0 unless the runtime exposes them.
    heapGrowthMb: (mem.heapUsed - lastHeapUsedBytes) / 1_048_576,
    gcPreciseCount: gcCount,
    gcPreciseTotalMs: gcTotalMs,
    // Host-wide heavy-read gate queue depth at sample time (cross-process flock
    // gauge; cheap synchronous read). Surfaces backend contention in the pane.
    heavyReadDepth: heavyReadQueueDepth(),
    // Monitoring self-cost this tick: the observability subsystem's own work
    // (everything under runWithoutProfiling), invisible to the profiler by
    // design — this delta is the only place it shows up.
    monitorOps: meter.count - lastMonitorOps,
    monitorMs: meter.totalMs - lastMonitorMs,
    wallJumpMs,
    sleptMs,
  };
  // Drain the JSC sampler for this window BEFORE resetting the histogram so the
  // drained samples and eventLoopMaxMs describe the same window. On a stall this
  // captures a `stall` trace with the dominant blocking stack; otherwise it just
  // bounds memory. The 2nd arg is the actual elapsed wall-time since the previous
  // drain, which on a stall is ~the block duration.
  if (stallArmed) {
    drainAndMaybeDump(sample.eventLoopMaxMs, sample.sampledAt - lastTickAt);
  } else if (
    sample.eventLoopP99Ms > STALL_ARM_P99_MS ||
    sample.eventLoopMaxMs > STALL_ARM_MAX_MS
  ) {
    // Non-main arm-on-elevated: trouble has appeared on this backend — arm the
    // profiler now (one-way) so the NEXT stall carries stack evidence. Logged
    // so the arming moment is auditable against later stall traces.
    startStallProfiler();
    stallArmed = true;
    channel.publish(
      `stall profiler armed (eventLoopP99Ms=${sample.eventLoopP99Ms.toFixed(1)}, eventLoopMaxMs=${sample.eventLoopMaxMs.toFixed(1)})`,
    );
  }
  lastTickAt = sample.sampledAt;
  histogram.reset();
  gcCount = 0;
  gcTotalMs = 0;
  lastHeapUsedBytes = mem.heapUsed;
  lastMonitorOps = meter.count;
  lastMonitorMs = meter.totalMs;
  rotateIfNeeded();
  channel.publish(JSON.stringify(sample));
  for (const observer of sampleObservers) observer(sample);
}

export function startProcessSampler(): void {
  if (processSamplerTimer.running) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  // Precise GC timing only when the runtime exposes 'gc' performance entries.
  // Bun 1.3.x does not (supportedEntryTypes lacks "gc"), so this stays inert
  // there and heap growth (bun:jsc) is the GC-pressure proxy instead.
  if (PerformanceObserver.supportedEntryTypes.includes("gc")) {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcCount += 1;
        gcTotalMs += entry.duration;
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  }
  lastHeapUsedBytes = process.memoryUsage().heapUsed;
  const meter = getSelfMeter();
  lastMonitorOps = meter.count;
  lastMonitorMs = meter.totalMs;
  lastTickAt = Date.now();
  sleepMeter = createSleepMeter();
  // Known from boot, not from the first tick 10 s later.
  publishSleepReading();
  // Arm the on-stall stack-trace flight recorder. Main: always, at boot (the
  // UX-critical backend). Worktree backends: arm-on-elevated in tick() — see
  // the STALL_ARM_* constants.
  if (isMain()) {
    startStallProfiler();
    stallArmed = true;
  }
  processSamplerTimer.start();
}

export function stopProcessSampler(): void {
  processSamplerTimer.stop();
  if (stallArmed) {
    stopStallProfiler();
    stallArmed = false;
  }
  if (gcObserver) {
    gcObserver.disconnect();
    gcObserver = null;
  }
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
}
