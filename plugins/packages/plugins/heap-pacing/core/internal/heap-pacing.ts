import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

// How far JavaScriptCore lets a heap grow before it collects, for the heavy
// bun processes this repo starts (a TypeScript program + typed ESLint).
//
// After a full collection with H bytes live, JSC lets the heap grow to about
// (1 + heapGrowthMaxIncrease · e^(−heapGrowthSteepnessFactor · H / ram)) · H
// before the next one (bun ships heapGrowthMaxIncrease 2, steepness 2;
// oven-sh/bun#39844). `ram` is the machine's whole RAM: JSC assumes it is the
// only process on it. On this 64 GB host a 4.4 GB heap — a real type-check
// batch — may grow ~2.7× before a collection, so the batch peaked at
// 8.6–9.7 GB for 4.4 GB of live data. Every heavy process does this at once,
// each believing the machine is its own.
//
// Telling JSC the process has `HEAVY_PROCESS_RAM_BYTES` instead makes the
// factor depend on the heap's size against that: a small heap (a script, a
// keyed run's 1 GB program) still grows ~2–3× and collects rarely, while a heap
// of several GB grows ~1.1–1.3× — the processes that hold the host's memory are
// the ones that pay for collecting more often.
//
// Measured on the heaviest batch of a cold whole-tree check (2,000 sources,
// 4.4 GB live after a full GC), peak RSS / CPU (research/
// 2026-11-08-global-type-check-bun-heap-pacing.md):
//
//   default (64 GB)  8.6–9.7 GB / 112 s     4 GB  6.95 GB / 125 s
//   6 GB             7.8 GB                 3 GB  6.8 GB  / 127 s
//   5 GB             6.9 GB  / 119 s        2 GB  6.7 GB  / 141 s
//
// `--smol`, `Bun.gc(true)` between phases or lint files, a lower
// heapGrowthMaxIncrease, no concurrent GC and MIMALLOC_PURGE_DELAY=0 moved the
// peak by less than run-to-run noise. There is no heap CAP on bun
// (`--max-old-space-size` is ignored, oven-sh/bun#34917): this paces the
// collector, it bounds nothing.

/** The JSC option, read from the environment once at VM start. */
export const JSC_RAM_SIZE_ENV = "BUN_JSC_forceRAMSize";

/**
 * The RAM a heavy process's heap is paced against: the knee of the sweep
 * above (3–5 GB give the same peak; 6 GB already gives most of it back, and
 * lower costs CPU for no memory).
 */
export const HEAVY_PROCESS_RAM_BYTES = 4e9;

/**
 * The RAM a check pass's own process is paced against. Its live heap is
 * ~1–1.5 GB (every plugin barrel loaded, a pass's memos), and a cold pass
 * (a first update after an install: no plugin record made yet) allocates GBs
 * of short-lived scan, fold and evaluation work on top of it. Against an 8 GB
 * machine's RAM, JSC lets that heap reach ~2.4× its live size before a full
 * collection (~2.9× on a 64 GB one), so the cold pass peaked at 3.1–3.4 GB of
 * anonymous memory on an 8 GB Linux host — the process the kernel killed.
 *
 * Measured there (every tree and deploy check but type-check, cold records,
 * peak anon RSS / wall): unpaced 3.09, 3.20, 3.43 GB / 66–78 s; 4 GB 3.49 GB /
 * 84 s; 2 GB 2.26, 2.56 GB / 81–84 s; 1.5 GB 2.54 GB / 89 s. 2 GB is the knee
 * (research/2026-11-19-global-cold-check-pass-gc-slack.md).
 */
export const CHECK_PROCESS_RAM_BYTES = 2e9;

/**
 * Marks a pace this repo set (`pacedHeapEnv`, the `./equin` shim), as against
 * one a person set. A pace is a property of the process it was chosen for: a
 * child spawned with a pace of its own replaces an inherited marked one, while
 * an unmarked one — a measurement's — wins everywhere below it.
 */
export const HEAP_PACED_ENV = envName("HEAP_PACED");

/**
 * `env` (a child's FULL environment, as spawn takes it) with the heap paced
 * for a heavy process, against `ramBytes` (default `HEAVY_PROCESS_RAM_BYTES`).
 * A caller whose process must stay inside a smaller memory share passes that
 * share's pace (a type-check worker admitted on one host unit: 1.5 GB, see the
 * type-check's memory profiles). The pace is the child's own: one its parent
 * was paced at by this repo (marked {@link HEAP_PACED_ENV}) is replaced — a
 * check pass paced at 2 GB still starts its type-check worker at the worker's
 * profile. A value a person set (no mark) wins: a measurement can pick its own
 * for a whole process tree. Returns a copy.
 */
export function pacedHeapEnv(
  env: Readonly<Record<string, string | undefined>>,
  ramBytes: number = HEAVY_PROCESS_RAM_BYTES,
): Record<string, string | undefined> {
  if (!(ramBytes > 0)) {
    throw new Error(`pacedHeapEnv: ramBytes must be positive, got ${ramBytes}`);
  }
  if (env[JSC_RAM_SIZE_ENV] !== undefined && env[HEAP_PACED_ENV] === undefined)
    return { ...env };
  return {
    ...env,
    [JSC_RAM_SIZE_ENV]: String(ramBytes),
    [HEAP_PACED_ENV]: "1",
  };
}

/**
 * `env` for a child that is part of its parent's own work (a type-check
 * worker's batch process): paced as the parent is, whatever paced it — the
 * parent's environment as is when it carries a pace, `pacedHeapEnv` when it
 * carries none. Returns a copy.
 */
export function parentPacedHeapEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  if (env[JSC_RAM_SIZE_ENV] !== undefined) return { ...env };
  return pacedHeapEnv(env);
}
