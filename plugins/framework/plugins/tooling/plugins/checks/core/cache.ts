import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { checkCacheDir } from "../data-dirs";
import type { ReadSet } from "./read-set";

// Global (not per-worktree) + content-keyed: the main-worktree auto-build can
// reuse passes recorded by an agent worktree for the identical (ff-merged) tree.
// The directory itself is declared in this plugin's `data-dirs/index.ts`.

// Pruning bounds — keep the dir from growing unbounded across weeks of trees.
// AGE is the intended evictor; the count is only a disk backstop, so it must sit
// far above a busy day's working set. The previous 5000/4000 did not: the dir was
// measured at 4682 live entries, i.e. one busy day of agent worktrees was already
// pressing the cap, and a trim to 4000 evicts entries recorded hours earlier —
// which is exactly what makes the cross-day (and cross-worktree) reuse this cache
// exists for impossible. 4× headroom at ~4.5 KB/entry bounds the dir at ~90 MB.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;
const TRIM_TO = 16000;
// How often the age sweep is allowed to run. `prune()` is called eagerly on every
// open, and its per-entry `statSync` pass dominates the cost (~95%; the readdir
// itself is a rounding error). Against a 14-day age bound an hourly sweep is
// plenty, so the common path stops after the readdir. See `prune()`.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MARKER_FILE = ".last-prune";
// A temp file is live only for the microseconds between its write and its
// rename, so anything past this window was orphaned by a hard kill. See
// `sweepOrphanTemps`.
const TEMP_ORPHAN_MS = 60 * 60 * 1000;

// A flight key (`check-flight.ts`) carries the tree hash, so its files are
// dead the moment the run that made them settles — but nothing deletes them
// then, and one triple per (check, tree) accumulates. A day idle is far past
// any check's run; reclaimed by the same hourly sweep as the temps.
const FLIGHT_IDLE_MS = 24 * 60 * 60 * 1000;
const FLIGHTS_SUBDIR = "flights";

/**
 * The per-check single-flight directory (`runCheckFlight`): host-global like
 * the cache itself, so concurrent check runs in every worktree coalesce on one
 * `(check, sig, treeHash)`. A subdirectory, so its files are never read as
 * cache entries by `prune()`'s `.json` pass.
 */
export function checkFlightDir(): string {
  return checkCacheDir.file(FLIGHTS_SUBDIR);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Publish `contents` at `file` atomically, safe against CONCURRENT publishers of
 * the SAME destination.
 *
 * The temp name MUST be unique per writer. Deriving it from the destination (as
 * this once did, via `sha256(file)`) makes every process pick the byte-identical
 * temp path, which loses both ways: one writer truncates the other's
 * half-written bytes, and whichever renames second dies on ENOENT because the
 * first rename already consumed the temp. That ENOENT propagates out of
 * `runChecks` and aborts the build.
 *
 * It is reachable, not theoretical: the cache dir is global (see above), and the
 * read-set slot is keyed on `(checkId, sig)` with NO treeHash — where `sig` is
 * `""` for every input-keyed check that declares no `cacheSignature()`. Two
 * worktrees building at once over a cache-cold check therefore publish to the
 * same path routinely.
 *
 * The temp is placed in the DESTINATION's own directory so the rename is
 * same-filesystem (hence atomic) by construction rather than by the cache dir
 * happening to be the parent.
 */
function publishAtomic(file: string, contents: string): void {
  const tmp = join(dirname(file), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, contents);
    // Atomic: readers see either the previous file or this complete one, never a
    // partial write. Concurrent publishers are last-writer-wins, and since both
    // slot kinds are self-verifying (a legacy entry's content is never read, a
    // read-set is validated by replay) either winner is correct.
    renameSync(tmp, file);
  } finally {
    // No-op on the happy path — the rename consumed `tmp`. Reclaims it when the
    // write or the rename threw; a hard kill is caught by `sweepOrphanTemps`.
    rmSync(tmp, { force: true });
  }
}

/**
 * Cache-key format version. Bump when the MEANING of a recorded entry changes
 * while its key would not — i.e. when entries recorded under the old regime are
 * no longer entries you would accept today. `v2` retires every entry recorded
 * before the isolated-runner change, when a build recorded passes from a
 * process that had already imported every plugin barrel; those verdicts were
 * not transferable and a later push read them anyway.
 *
 * NOT the same thing as `ReadSet.sourceHash`. That hashes the check-system
 * source, lives INSIDE the read-set payload and is verified on read, so it
 * invalidates on a change to check LOGIC. It cannot help the legacy slot at
 * all: `has()` is a bare `existsSync` that never opens the file, so nothing
 * inside a legacy entry is ever read. The only way to retire one is to change
 * its NAME — which is what this constant does. So: never bump for a change in
 * check logic (that is `sourceHash`'s job), only for a change in what a
 * recorded entry means.
 *
 * NEVER REVERT A BUMP. Going back to a retired version re-addresses the exact
 * entries it was raised to abandon. To undo `v2`, go to `v3`.
 *
 * Orphaned entries under an old version are not deleted — they simply become
 * unreachable and age out under the existing 14-day `prune()` sweep, well
 * inside the 20 000-entry backstop. The cost of a bump is one cold pass per
 * tree.
 */
const CACHE_KEY_VERSION = "v2";

/**
 * The ONE place a cache slot name is minted — a half-invalidated cache is worse
 * than none, because the surviving half is the half nobody thought about. Both
 * slot kinds route through here, so "bump one and forget the other" has no
 * spelling.
 */
function slotName(parts: string[], suffix: string): string {
  return checkCacheDir.file(
    `${sha256([CACHE_KEY_VERSION, ...parts].join(":"))}${suffix}`,
  );
}

function entryFile(checkId: string, treeHash: string, sig: string): string {
  return slotName([treeHash, checkId, sha256(sig)], ".json");
}

// Input-keyed read-set slot: a SINGLE slot per (checkId, sig) — NOT keyed on
// treeHash — holding the latest recorded read-set. Validate-by-replay
// (`read-set.ts` `validate`) checks it against a fresh snapshot, so one slot
// serves the monotonic-forward push-rebase path. Suffixed `.readset.json` so it
// still ends in `.json` and is swept by the same `prune()` as the legacy slots,
// while never colliding with a legacy `${sha256(key)}.json` name.
function readSetFile(checkId: string, sig: string): string {
  return slotName([checkId, sha256(sig)], ".readset.json");
}

export interface CheckCache {
  /** True iff a PASS was recorded for this (check, tree, sig). */
  has(checkId: string, treeHash: string, sig: string): boolean;
  /** Record a PASS. Atomic, and safe against concurrent publishers of the same slot. */
  record(checkId: string, treeHash: string, sig: string): void;
  /**
   * Load the latest recorded read-set for (check, sig), or null if none / on any
   * read/parse error (fail-open — a corrupt slot must degrade to a cache MISS,
   * never a false HIT). Validated by `read-set.ts` `validate` before use.
   */
  loadReadSet(checkId: string, sig: string): ReadSet | null;
  /**
   * Record (overwrite) the read-set for a PASS. Atomic, and safe against
   * concurrent publishers of the same slot — which is the common case, since
   * this slot is NOT keyed on treeHash and the cache dir is global.
   */
  recordReadSet(checkId: string, sig: string, readSet: ReadSet): void;
}

/** Open (and lazily create) the global check-result cache. */
export function openCheckCache(): CheckCache {
  // A genuinely unwritable home is a real fault and should surface loudly.
  checkCacheDir.ensure();
  prune();
  return {
    has(checkId, treeHash, sig) {
      return existsSync(entryFile(checkId, treeHash, sig));
    },
    record(checkId, treeHash, sig) {
      publishAtomic(
        entryFile(checkId, treeHash, sig),
        JSON.stringify({ checkId, treeHash, recordedAt: Date.now() }),
      );
    },
    loadReadSet(checkId, sig) {
      const file = readSetFile(checkId, sig);
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, "utf8")) as ReadSet;
        // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- fail-open: a corrupt/half-written slot must degrade to a cache MISS (run the check), never a false HIT; null here means "no usable read-set", which the caller treats exactly as absent
      } catch {
        return null;
      }
    },
    recordReadSet(checkId, sig, readSet) {
      publishAtomic(readSetFile(checkId, sig), JSON.stringify(readSet));
    },
  };
}

// True iff the age sweep is due (marker absent or older than the interval). The
// marker is `.last-prune`, which does not end in `.json` and so is never itself
// listed as an entry.
function ageSweepDue(now: number): boolean {
  try {
    return (
      now - statSync(checkCacheDir.file(MARKER_FILE)).mtimeMs >
      PRUNE_INTERVAL_MS
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return true; // never swept
  }
}

// Reclaim temp files orphaned by a HARD kill between write and rename — the
// in-process failure paths already clean up in `publishAtomic`'s `finally`.
// Necessary because the temp name is now unique per writer: the old
// destination-derived name self-limited the leak to one file per destination,
// whereas a unique name would accumulate one per killed build forever. Runs on
// the same gated cadence as the age sweep (temps are `.tmp`, so they are neither
// counted as entries nor swept by the `.json` pass below); orphans are rare
// enough that hourly reclamation is ample, and this keeps the common path's work
// to just the readdir.
function sweepOrphanTemps(all: string[], now: number): void {
  for (const name of all) {
    if (!name.endsWith(".tmp")) continue;
    const path = checkCacheDir.file(name);
    try {
      if (now - statSync(path).mtimeMs <= TEMP_ORPHAN_MS) continue; // maybe in flight
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue; // vanished underneath us — its owner finished the publish
    }
    rmSync(path, { force: true });
  }
}

// Opportunistic pruning: age-out stale entries, then cap total count. Cheap
// stat-based pass; tolerates the readdir/stat race (a concurrent writer may
// delete an entry between listing and stat). Both legacy `.json` slots and the
// input-keyed `.readset.json` slots end in `.json`, so one sweep ages/caps both.
//
// The readdir is cheap but the per-entry stat pass is not, so the sweep runs only
// when it can actually do something: either the count backstop is genuinely
// breached (checked straight off the readdir, so it still triggers the instant it
// must) or the hourly age sweep is due. Both bounds are preserved exactly; only
// the cadence of the age sweep changes.
function prune(): void {
  const all = readdirSync(checkCacheDir.path);
  const names = all.filter((n) => n.endsWith(".json"));
  const now = Date.now();
  if (names.length <= MAX_ENTRIES && !ageSweepDue(now)) return;
  writeFileSync(checkCacheDir.file(MARKER_FILE), "");
  sweepOrphanTemps(all, now);
  sweepIdleFlights(now);
  const live: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = checkCacheDir.file(name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue; // entry vanished underneath us — nothing to prune
    }
    if (now - mtimeMs > MAX_AGE_MS) {
      rmSync(path, { force: true });
    } else {
      live.push({ path, mtimeMs });
    }
  }
  if (live.length > MAX_ENTRIES) {
    live.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const { path } of live.slice(0, live.length - TRIM_TO)) {
      rmSync(path, { force: true });
    }
  }
}

/**
 * Reclaim the flight files (`checkFlightDir()`) of keys idle for a day: per
 * key `<h>.lock`, `<h>.leader.json`, `<h>.verdict.json`, plus a publish's
 * `<h>.*.json.tmp.<pid>` a hard kill orphaned.
 *
 * A key's files go only while this process HOLDS its lock (`flockTry`), so a
 * lock a run is holding is never deleted. The one race left is benign: a run
 * that opened the lock file just before the unlink takes its lock on the
 * orphaned inode while a later run creates a fresh one — two leaders for one
 * key, i.e. the check runs twice, never a wrong verdict (both run the same
 * key's work, and a verdict is only ever adopted for that key). It needs a key
 * idle for a day to come back within that instant, and the key carries the
 * tree hash, so in practice it is never reused at all.
 */
function sweepIdleFlights(now: number): void {
  const dir = checkFlightDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no flight yet
    throw err;
  }
  const mtimeOf = (name: string): number | null => {
    try {
      return statSync(join(dir, name)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return null; // vanished underneath us
    }
  };
  const byKey = new Map<string, string[]>();
  for (const name of names) {
    if (name.includes(".tmp.")) {
      const mtimeMs = mtimeOf(name);
      if (mtimeMs !== null && now - mtimeMs > TEMP_ORPHAN_MS)
        rmSync(join(dir, name), { force: true });
      continue;
    }
    const key = name.split(".")[0] ?? name;
    byKey.set(key, [...(byKey.get(key) ?? []), name]);
  }
  for (const [key, files] of byKey) {
    const newest = Math.max(0, ...files.map((f) => mtimeOf(f) ?? 0));
    if (now - newest <= FLIGHT_IDLE_MS) continue;
    const lock = `${key}.lock`;
    if (!files.includes(lock)) {
      // A leader/verdict whose lock is gone: no run can be using it.
      for (const f of files) rmSync(join(dir, f), { force: true });
      continue;
    }
    const fd = openSync(join(dir, lock), "a");
    try {
      if (!flockTry(fd)) continue; // a run holds it: in use, not idle
      for (const f of files)
        if (f !== lock) rmSync(join(dir, f), { force: true });
      rmSync(join(dir, lock), { force: true });
    } finally {
      closeSync(fd);
    }
  }
}
