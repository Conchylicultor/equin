// How much physical memory a process holds — read through a probe the HOST
// installs, because the only honest reading needs the computer: on macOS it is
// `proc_pid_rusage`'s phys_footprint over bun:ffi, on Linux procfs's Pss of
// anonymous + shared memory (packages/proc-rusage, read by
// `bin/phys-footprint.ts`, installed by `bin/host-probes.ts` in both boot
// modes). `core` runs on every
// host, so it holds the shape and the delegate, never the syscall.
//
// Until a probe is installed — a browser host, a test that boots no `bin/` —
// every read answers `null`, the same "no footprint here" answer a desktop on
// another OS gives, which every consumer already handles (they fall
// back to `process.memoryUsage().rss`).

export interface ProcMemory {
  /** macOS: ri_phys_footprint — the kernel's memory-pressure charge, INCLUDING
   * the process's compressed private pages. Linux: its anonymous and
   * shared-memory pages in RAM — RssAnon + RssShmem from the kernel's counters
   * (`procMemory`), or smaps_rollup's Pss_Anon + Pss_Shmem (`peerProcUsage`),
   * in the terms of the host's AnonPages + Shmem. */
  physFootprintBytes: number;
  /** ri_resident_size (Linux: VmRSS, file pages included — so the
   * squeezed-out difference below is macOS's only) —
   * pages physically in RAM right now, EXCLUDING pages
   * sitting in the compressor / swapped out. `physFootprintBytes −
   * residentSizeBytes` therefore approximates the process's squeezed-out bytes
   * — the direct paging-victimhood signal (see
   * research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md §A2).
   * Do NOT substitute `process.memoryUsage().rss` here: on macOS it over-counts
   * ~6× (Gigacage etc., see `bin/phys-footprint.ts`), which makes the
   * difference negative and meaningless. */
  residentSizeBytes: number;
  /** ri_lifetime_max_phys_footprint — the highest `physFootprintBytes` the
   * process has had over its life, kept after it gives the memory back.
   * Linux keeps no such peak: the memory now plus how far the resident size
   * fell since its peak (VmHWM − VmRSS), an estimate, usually high (packages/proc-rusage
   * `proc-linux.ts`). */
  peakPhysFootprintBytes: number;
  /**
   * How a page several processes map is charged: `whole` to each (macOS's
   * footprint, Linux's counters — summing a fork tree's members counts its
   * shared segment once per member), or `proportional`, 1/N to each (Linux's
   * Pss — a sum counts every page once).
   */
  sharedPages: "whole" | "proportional";
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

/**
 * CPU time a process has used, ns: its own (user + system), and that of every
 * child it has reaped (`ri_child_*`, which already holds the grandchildren
 * each child reaped). The second is the only trace a short-lived process leaves
 * once it exited — a hook, a `git`, an `rg` — which a `ps` snapshot never sees.
 */
export interface ProcCpu {
  ownNs: number;
  reapedChildrenNs: number;
}

/**
 * Another process's memory and CPU, where refusal is an ANSWER — its memory
 * charged so a sum over processes counts a shared page once where the OS can
 * say so (Linux's Pss: `sharedPages: "proportional"`, a page-table walk the
 * kernel does per process, hence async; macOS's footprint, `whole`): the kernel will not tell one account about another account's
 * process, and a pid listed a moment ago may have exited since. Distinct from
 * `procMemory`, whose failure on its own process means a broken probe and
 * throws.
 */
export type PeerUsage =
  | { kind: "read"; memory: ProcMemory; cpu: ProcCpu }
  /** Not this account's process, or gone since it was listed. */
  | { kind: "unreadable" }
  /** This host has no phys_footprint equivalent (or installed no probe). */
  | { kind: "unsupported" };

export type PeerUsageProbe = (pid: number) => Promise<PeerUsage>;

let peerProbe: PeerUsageProbe | null = null;

/** Install this host's peer usage probe. Once per process, before boot. */
export function installPeerUsageProbe(fn: PeerUsageProbe): void {
  if (peerProbe !== null) {
    throw new Error("[memory-probe] a peer usage probe is already installed.");
  }
  peerProbe = fn;
}

/** Memory and CPU of another process — see `PeerUsage`. */
export async function peerProcUsage(pid: number): Promise<PeerUsage> {
  return peerProbe === null ? { kind: "unsupported" } : peerProbe(pid);
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

let cpuReader: (() => number) | null = null;

/**
 * Install this host's own-CPU reader: the CPU time this process has used so
 * far, ms (user + system — `process.cpuUsage()` on the desktop). Once per
 * process, before boot. A host without one (the browser worker) records no
 * CPU on its boot checkpoints — absent, never a made-up zero.
 */
export function installCpuReader(fn: () => number): void {
  if (cpuReader !== null) {
    throw new Error("[memory-probe] a CPU reader is already installed.");
  }
  cpuReader = fn;
}

/** CPU this process has used so far (ms), or `null` when the host installed no reader. */
export function ownCpuMs(): number | null {
  return cpuReader === null ? null : cpuReader();
}
