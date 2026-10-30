import { heapMemory, physFootprintBytes } from "./memory-probe";

export type PhaseId =
  | "register"
  | "awaitPgReady"
  | "runMigrations"
  | "routePopulation"
  | "socketBind"
  | "onReadyBlocking"
  | "onReady"
  | "onAllReady"
  // The serving host's settled phase (`runSettledPhase`), after the onAllReady
  // barrier: `settled` is the wrapping span — its presence marks a complete
  // boot profile — each plugin's hook an `onSettled:<id>` span, and each
  // drained warm-up (infra/warmup) a `warmup:<name>` span.
  | "settled"
  | "onSettled"
  | "warmup";

export interface Span {
  id: string;
  phase: PhaseId;
  plugin?: string;
  label: string;
  startMs: number;
  durationMs: number;
  /** phys_footprint (MB) at span start — the real macOS footprint, not rss. */
  physFootprintStartMb?: number;
  /** phys_footprint (MB) at span end. */
  physFootprintEndMb?: number;
}

/**
 * A phase-boundary memory snapshot. Unlike per-span footprint deltas (which overlap
 * for plugins running under Promise.all in onReadyBlocking/onReady and are only
 * directional), these boundary checkpoints are the authoritative numbers.
 */
export interface MemoryCheckpoint {
  label: string;
  atMs: number;
  /** Real macOS phys_footprint (MB); falls back to rss off-darwin. */
  physFootprintMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

const bootStart = performance.now();
const spans: Span[] = [];
const idCounts = new Map<string, number>();
const memoryCheckpoints: MemoryCheckpoint[] = [];
let timeToReadyMs: number | null = null;

/** bytes → MB, rounded to 1 decimal. */
function toMb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

/**
 * Real macOS phys_footprint in bytes, falling back to rss off-darwin (where
 * proc_pid_rusage has no equivalent). The host is the user's Mac, so this is
 * effectively always the true footprint. `null` on a host that installed
 * neither probe (the browser worker).
 */
function footprintBytes(): number | null {
  return physFootprintBytes() ?? heapMemory()?.rss ?? null;
}

function footprintMb(): number | undefined {
  const bytes = footprintBytes();
  return bytes === null ? undefined : toMb(bytes);
}

export function profilerStart(
  id: string,
  phase: PhaseId,
  label: string,
  plugin?: string,
): () => void {
  const count = idCounts.get(id) ?? 0;
  idCounts.set(id, count + 1);
  const uniqueId = count === 0 ? id : `${id}:${count}`;
  const t0 = performance.now();
  const physFootprintStartMb = footprintMb();
  return () => {
    spans.push({
      id: uniqueId,
      phase,
      plugin,
      label,
      startMs: Math.round(t0 - bootStart),
      durationMs: Math.round(performance.now() - t0),
      physFootprintStartMb,
      physFootprintEndMb: footprintMb(),
    });
  };
}

/**
 * Record a process-wide memory snapshot at a clean boot-phase boundary.
 * These boundary checkpoints are the authoritative per-phase footprint numbers
 * (per-span deltas inside parallel phases overlap and are only directional).
 */
export function recordMemoryCheckpoint(label: string): void {
  // A host with no heap reader has nothing to record.
  const mem = heapMemory();
  if (mem === null) return;
  memoryCheckpoints.push({
    label,
    atMs: Math.round(performance.now() - bootStart),
    physFootprintMb: toMb(physFootprintBytes() ?? mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
  });
}

/**
 * Stamp the instant this backend became ready — called by `markServerReady()`
 * only, so the profiler's ready instant cannot drift from the flag
 * `/api/health/ready` reports and the gateway hot-swaps on.
 */
export function recordReadyInstant(): void {
  timeToReadyMs = Math.round(performance.now());
}

export function getProfilingData(): {
  spans: Span[];
  totalDurationMs: number;
  memoryCheckpoints: MemoryCheckpoint[];
  /**
   * Where span / checkpoint offsets start, in ms after process start
   * (`performance.timeOrigin`): this module's evaluation. Adding it to
   * `timeOrigin` places an offset on the wall clock.
   */
  bootStartOffsetMs: number;
  /**
   * Ms from process start (`performance.timeOrigin` — the clock the gateway
   * and `boot.jsonl` measure on, NOT the span offsets' axis) to
   * `markServerReady()`: how long the backend took to become ready. `null`
   * until then, and always in a host that never marks ready (`exec`, browser).
   * Post-ready work (`onReady`, the settled phase's warm-up drain) is not in it.
   */
  timeToReadyMs: number | null;
} {
  const totalDurationMs =
    spans.length === 0
      ? 0
      : Math.max(...spans.map((s) => s.startMs + s.durationMs));
  return {
    spans,
    totalDurationMs,
    memoryCheckpoints,
    bootStartOffsetMs: bootStart,
    timeToReadyMs,
  };
}
