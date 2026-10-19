// How much physical memory a process holds — read through a probe the HOST
// installs, because the only honest reading needs the computer: on macOS it is
// `proc_pid_rusage`'s phys_footprint over bun:ffi (`bin/phys-footprint.ts`,
// installed by `bin/host-probes.ts` in both boot modes). `core` runs on every
// host, so it holds the shape and the delegate, never the syscall.
//
// Until a probe is installed — a browser host, a test that boots no `bin/` —
// every read answers `null`, the same "no phys_footprint here" answer a
// non-macOS desktop gives, which every consumer already handles (they fall
// back to `process.memoryUsage().rss`).

export interface ProcMemory {
  /** ri_phys_footprint — the kernel's memory-pressure charge, INCLUDING the
   * process's compressed private pages. */
  physFootprintBytes: number;
  /** ri_resident_size — pages physically in RAM right now, EXCLUDING pages
   * sitting in the compressor / swapped out. `physFootprintBytes −
   * residentSizeBytes` therefore approximates the process's squeezed-out bytes
   * — the direct paging-victimhood signal (see
   * research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md §A2).
   * Do NOT substitute `process.memoryUsage().rss` here: on macOS it over-counts
   * ~6× (Gigacage etc., see `bin/phys-footprint.ts`), which makes the
   * difference negative and meaningless. */
  residentSizeBytes: number;
}

/** A host's reading of `pid`'s memory (this process when omitted); `null` where
 *  the host has no phys_footprint equivalent. */
export type MemoryProbe = (pid?: number) => ProcMemory | null;

let probe: MemoryProbe | null = null;

/** Install this host's memory probe. Once per process, before boot. */
export function installMemoryProbe(fn: MemoryProbe): void {
  if (probe !== null) {
    throw new Error("[memory-probe] a memory probe is already installed.");
  }
  probe = fn;
}

/**
 * Physical memory metrics of `pid` (defaults to this process), from the
 * installed probe; `null` when none is installed or the host has no
 * phys_footprint equivalent.
 */
export function procMemory(pid?: number): ProcMemory | null {
  return probe === null ? null : probe(pid);
}

/** Physical memory footprint of `pid` in bytes — see `procMemory`. */
export function physFootprintBytes(pid?: number): number | null {
  return procMemory(pid)?.physFootprintBytes ?? null;
}

/** The JS engine's view of this process's memory — `process.memoryUsage()`'s shape. */
export interface HeapMemory {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

let heapReader: (() => HeapMemory) | null = null;

/**
 * Install this host's heap reader (`process.memoryUsage` on the desktop). Once
 * per process, before boot. A host without one (the browser worker) records no
 * memory checkpoints and no span footprints — absent, never a made-up zero.
 */
export function installHeapReader(fn: () => HeapMemory): void {
  if (heapReader !== null) {
    throw new Error("[memory-probe] a heap reader is already installed.");
  }
  heapReader = fn;
}

/** This process's heap reading, or `null` when the host installed no reader. */
export function heapMemory(): HeapMemory | null {
  return heapReader === null ? null : heapReader();
}
