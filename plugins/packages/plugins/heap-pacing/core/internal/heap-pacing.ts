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
 * `env` (a child's FULL environment, as spawn takes it) with the heap paced
 * for a heavy process. A value already set wins: a measurement can pick its
 * own, and a paced process's children inherit the same one. Returns a copy.
 */
export function pacedHeapEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  if (env[JSC_RAM_SIZE_ENV] !== undefined) return { ...env };
  return { ...env, [JSC_RAM_SIZE_ENV]: String(HEAVY_PROCESS_RAM_BYTES) };
}
