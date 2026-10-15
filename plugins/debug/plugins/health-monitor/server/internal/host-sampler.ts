import { freemem, loadavg, totalmem } from "node:os";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { HostSample } from "../../core";
import { parseVmStat, type VmStat } from "./vm-stat";
import { detectWallJumpMs } from "./wall-jump";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";

const VM_STAT_TIMEOUT_MS = 5_000;

// Host-level sampler. Runs only on the main backend (the host is a shared
// resource — one sampler suffices). Appends to the singularity worktree's
// health-host.jsonl. Same timer rationale as process-sampler.ts.

const SAMPLE_INTERVAL_MS = 10_000;

// Main-only (host metrics are the machine's, not this backend's), and
// profiler-invisible like the process sampler.
export const hostSamplerTimer = defineTimer({
  name: "health.host-sampler",
  description:
    "Samples the machine's memory, swap, compression and load every 10 seconds into the host health log, which the sentinel and Debug → Health read.",
  everyMs: SAMPLE_INTERVAL_MS,
  mainOnly: true,
  profile: "invisible",
  run: tick,
});
// Declared once at module eval (not in start): the sampler can be stopped and
// restarted, and `defineLogSink` throws on a duplicate id. PERF sink.
const channel = defineLogSink({
  id: "health-host",
  description:
    "PERF sink: host-level health samples (load average, memory, swap) for the Debug → Health charts.",
});
// Wall-time of the previous tick: the true denominator for the vm_stat rate
// deltas (a late tick divided by the nominal cadence would inflate the rates —
// after a sleep, catastrophically so), and the wall-jump detection baseline.
let lastTickAt = 0;
let prev: {
  swapins: number;
  swapouts: number;
  compressions: number;
  decompressions: number;
} | null = null;

// macOS-only swap/compressor detail. Returns null elsewhere (host is the user's
// Mac); the sample then reports 0 for the swap fields.
async function readVmStat(): Promise<VmStat | null> {
  if (process.platform !== "darwin") return null;
  // Bounded well under the sampler's own cadence: a `vm_stat` that has not
  // answered within five seconds is not going to produce a reading worth this
  // tick, and letting it run would let successive ticks pile up children.
  const result = await spawnCaptured(["vm_stat"], {
    timeoutMs: VM_STAT_TIMEOUT_MS,
  });
  return parseVmStat(result.stdout);
}

// Host-sample observers — same shape and same rules as `onHealthSample` in
// process-sampler.ts. Main only, because the host sampler is.
export type HostSampleObserver = (sample: HostSample) => void;
const hostSampleObservers = new Set<HostSampleObserver>();
export function onHostSample(cb: HostSampleObserver): () => void {
  hostSampleObservers.add(cb);
  return () => hostSampleObservers.delete(cb);
}

async function tick(): Promise<void> {
  const now = Date.now();
  const wallJumpMs = detectWallJumpMs(now, lastTickAt, SAMPLE_INTERVAL_MS);
  // True elapsed window for the rate deltas, not the nominal cadence: a late
  // tick (wedged loop or sleep) otherwise divides a multi-window counter delta
  // by 10 s and fabricates a rate spike.
  const elapsedSec = Math.max((now - lastTickAt) / 1000, 1);
  lastTickAt = now;
  const vm = await readVmStat();
  let swapIn = 0;
  let swapOut = 0;
  let compressionsPerSec = 0;
  let decompressionsPerSec = 0;
  let compressorMb = 0;
  if (vm) {
    const swapins = vm.map["Swapins"] ?? 0;
    const swapouts = vm.map["Swapouts"] ?? 0;
    const compressions = vm.map["Compressions"] ?? 0;
    const decompressions = vm.map["Decompressions"] ?? 0;
    if (prev) {
      swapIn = Math.max(0, (swapins - prev.swapins) / elapsedSec);
      swapOut = Math.max(0, (swapouts - prev.swapouts) / elapsedSec);
      compressionsPerSec = Math.max(
        0,
        (compressions - prev.compressions) / elapsedSec,
      );
      decompressionsPerSec = Math.max(
        0,
        (decompressions - prev.decompressions) / elapsedSec,
      );
    }
    prev = { swapins, swapouts, compressions, decompressions };
    compressorMb =
      ((vm.map["Pages occupied by compressor"] ?? 0) * vm.pageSize) / 1_048_576;
  }
  const total = totalmem();
  const free = freemem();
  // This is the persisted host loadavg (10s cadence, health-host channel — the
  // single source for compressor/swap/freeMem, tail-read by the sentinel). The
  // sentinel worker deliberately keeps its OWN fresh loadavg() syscall on its
  // latch-critical thread rather than reading this file — freshness beats dedup
  // there. See worker/sample.ts and both CLAUDE.mds ("Host-metric ownership").
  const la = loadavg();
  const sample: HostSample = {
    sampledAt: now,
    freeMemMb: free / 1_048_576,
    totalMemMb: total / 1_048_576,
    usedMemMb: (total - free) / 1_048_576,
    loadAvg1: la[0] ?? 0,
    loadAvg5: la[1] ?? 0,
    loadAvg15: la[2] ?? 0,
    swapInPagesPerSec: swapIn,
    swapOutPagesPerSec: swapOut,
    compressionsPerSec,
    decompressionsPerSec,
    compressorMb,
    wallJumpMs,
  };
  channel.publish(JSON.stringify(sample));
  for (const observer of hostSampleObservers) observer(sample);
}

export function startHostSampler(): void {
  if (hostSamplerTimer.running) return;
  lastTickAt = Date.now();
  hostSamplerTimer.start();
}

export function stopHostSampler(): void {
  hostSamplerTimer.stop();
}
