import type { SpawnWaitDetail } from "./types";

/** The end of one child's metered run: what it was for, or `undefined`. */
export type SpawnWaitEnd = (detail: SpawnWaitDetail | undefined) => void;

/** Begins one child's run as a wait on `layer`; the end charges it. */
export type SpawnWaitMeter = (layer: string) => SpawnWaitEnd;

const NO_END: SpawnWaitEnd = () => {};
let meter: SpawnWaitMeter | null = null;

/**
 * Install how every `spawnCaptured` child is metered — a backend's runtime
 * profiler installs an `io` wait (`beginDescribedWait(layer, "io")`), shown
 * on the caller's span while the child runs and charged as it is reaped. A
 * child is another process's work: its time is never the caller's own code,
 * and a slow one is judged on its own duration, whoever awaited it (`wait
 * spawn:<program>`, or the caller's name — `git:status`). One per process,
 * `null` to remove; installed, not imported, because the profiler's server
 * half imports this plugin. No meter (a CLI): children are not metered.
 */
export function installSpawnWaitMeter(m: SpawnWaitMeter | null): void {
  meter = m;
}

/** Begin metering one child's run (a no-op end with no meter installed). */
export function beginSpawnWait(layer: string): SpawnWaitEnd {
  return meter ? meter(layer) : NO_END;
}
