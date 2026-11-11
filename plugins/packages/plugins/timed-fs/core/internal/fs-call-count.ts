import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import type { FsWaitLayer } from "./timed-fs";

// How MANY file calls a piece of work makes — the other half of a stalled disk.
// On 2026-11-03 most of a week's slowdown was our own code doing far too much
// file work even when nothing changed (a build re-reading ~450k links, a check
// re-reading 11k files per run): cheap on a warm cache, so nobody noticed until
// a host problem multiplied it. Timing alone cannot see that; a count can.
//
// Every timed call (and every glob scan, once) is counted twice, synchronously
// as it starts:
//
// - into the PROCESS tally, always — a span opened and closed around work
//   (`snapshotFsCalls` / `fsCallsSince`) reads the calls the process made in
//   between, whoever made them;
// - into every SCOPE tally the call's async context runs under
//   (`withFsCallTally`) — exact per unit of work even when units interleave on
//   one thread (the checks of one pass).
//
// Each call is also counted under its path PREFIX (the first directories of
// its target, relative to the process's cwd or the home dir), so a step whose
// calls jumped can name where the extra calls went.

/** Calls per layer, in the short spelling the durable records use. */
export interface FsCallCounts {
  stat: number;
  readdir: number;
  read: number;
  glob: number;
}

/** The record key each wait layer is counted under. */
const COUNT_KEY = {
  "fs-stat": "stat",
  "fs-readdir": "readdir",
  "fs-read": "read",
  "fs-glob": "glob",
} as const satisfies Record<FsWaitLayer, keyof FsCallCounts>;

/** A mutable tally: counts per layer, and calls per path prefix. */
export interface FsCallTally {
  readonly counts: FsCallCounts;
  readonly byPrefix: Map<string, number>;
}

/**
 * What a span or a scope made, as data: its counts per layer, their total, and
 * the prefixes most of the calls went to (most first). What every durable
 * record carries.
 */
export interface FsCallSummary extends FsCallCounts {
  total: number;
  top: { prefix: string; calls: number }[];
}

/** How many prefixes a summary names. */
export const FS_CALL_TOP_PREFIXES = 5;

/**
 * Below this many calls a summary names no prefix: a few calls need no
 * "where", and the durable records carry one summary per step.
 */
const TOP_MIN_TOTAL = 100;

/**
 * Distinct prefixes one tally keeps; the rest are counted under `(other)`.
 * Bounds the memory of a process that touches many trees.
 */
const PREFIX_CAP = 2048;
const OTHER = "(other)";

/** Directory levels a prefix keeps below its base (`./`, `~/`, `/`). */
const PREFIX_DEPTH = 3;

export function newFsCallTally(): FsCallTally {
  return {
    counts: { stat: 0, readdir: 0, read: 0, glob: 0 },
    byPrefix: new Map(),
  };
}

const processTally = newFsCallTally();

/** Every file call this process (this realm: a Worker has its own) made. */
export function processFsCallTally(): FsCallTally {
  return processTally;
}

interface ScopeFrame {
  tally: FsCallTally;
  parent: ScopeFrame | undefined;
}
const scopes = new AsyncLocalStorage<ScopeFrame>();

/**
 * Run `fn` with every file call in its async context (awaited continuations
 * included) also counted into `tally`. Scopes nest: a call counts into every
 * enclosing tally.
 */
export function withFsCallTally<T>(tally: FsCallTally, fn: () => T): T {
  return scopes.run({ tally, parent: scopes.getStore() }, fn);
}

const HOME = homedir();
const CWD = process.cwd();

/**
 * The call's path, cut to its first directories: `./plugins/apps/plugins` under
 * the cwd, `~/.equin/cache/type-check` under home, `(fd)` for a descriptor.
 * The last segment (the file itself) is never kept.
 */
export function fsCallPrefix(target: unknown): string {
  let path: string;
  if (typeof target === "string") path = target;
  else if (target instanceof URL) path = target.pathname;
  else if (target instanceof Uint8Array)
    path = new TextDecoder().decode(target);
  else if (typeof target === "number") return "(fd)";
  else if (target !== null && typeof target === "object" && "fd" in target)
    return "(fd)";
  else return "(none)";
  let base = "";
  let rest = path;
  if (rest.startsWith(`${CWD}/`)) {
    base = "./";
    rest = rest.slice(CWD.length + 1);
  } else if (rest.startsWith(`${HOME}/`)) {
    base = "~/";
    rest = rest.slice(HOME.length + 1);
  } else if (rest.startsWith("/")) {
    base = "/";
    rest = rest.slice(1);
  } else if (rest.startsWith("./")) {
    base = "./";
    rest = rest.slice(2);
  }
  let end = -1;
  for (let depth = 0; depth < PREFIX_DEPTH; depth++) {
    const next = rest.indexOf("/", end + 1);
    if (next < 0) break;
    end = next;
  }
  return end < 0 ? base || "." : base + rest.slice(0, end);
}

function bump(tally: FsCallTally, key: keyof FsCallCounts, prefix: string) {
  tally.counts[key]++;
  const m = tally.byPrefix;
  const n = m.get(prefix);
  if (n !== undefined) m.set(prefix, n + 1);
  else if (m.size < PREFIX_CAP) m.set(prefix, 1);
  else m.set(OTHER, (m.get(OTHER) ?? 0) + 1);
}

/** Count one call — timed-fs's every entry point calls this as it starts. */
export function countFsCall(layer: FsWaitLayer, target: unknown): void {
  const key = COUNT_KEY[layer];
  const prefix = fsCallPrefix(target);
  bump(processTally, key, prefix);
  for (let f = scopes.getStore(); f !== undefined; f = f.parent)
    bump(f.tally, key, prefix);
}

/** A tally as it stood at one instant — the start of a span. */
export interface FsCallSnapshot {
  counts: FsCallCounts;
  byPrefix: Map<string, number>;
}

export function snapshotFsCalls(
  tally: FsCallTally = processTally,
): FsCallSnapshot {
  return { counts: { ...tally.counts }, byPrefix: new Map(tally.byPrefix) };
}

function summary(
  counts: FsCallCounts,
  byPrefix: Iterable<[string, number]>,
): FsCallSummary {
  const total = counts.stat + counts.readdir + counts.read + counts.glob;
  if (total < TOP_MIN_TOTAL) return { ...counts, total, top: [] };
  const top = [...byPrefix]
    .filter(([, calls]) => calls > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FS_CALL_TOP_PREFIXES)
    .map(([prefix, calls]) => ({ prefix, calls }));
  return { ...counts, total, top };
}

/** What a tally holds now, summarized. */
export function summarizeFsCalls(tally: FsCallTally): FsCallSummary {
  return summary({ ...tally.counts }, tally.byPrefix);
}

/** The calls a tally gained since `since` — what a span made, summarized. */
export function fsCallsSince(
  since: FsCallSnapshot,
  tally: FsCallTally = processTally,
): FsCallSummary {
  const c = tally.counts;
  const s = since.counts;
  const counts: FsCallCounts = {
    stat: c.stat - s.stat,
    readdir: c.readdir - s.readdir,
    read: c.read - s.read,
    glob: c.glob - s.glob,
  };
  const delta: [string, number][] = [];
  for (const [prefix, n] of tally.byPrefix) {
    const d = n - (since.byPrefix.get(prefix) ?? 0);
    if (d > 0) delta.push([prefix, d]);
  }
  return summary(counts, delta);
}
