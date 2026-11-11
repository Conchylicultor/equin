import { mkdir, rename } from "node:fs/promises";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// A directory of things a removed checkout leaves for the next checkout — its
// dependency store (dep-store-pool.ts), its tracked tree (tree-pool.ts) —
// every move in it one `rename` on the same volume.
//
// THE NAMES. `<ms>-<checkout>` is a published entry (a dir holding the
// pool's own payload); every dot-name is transient and owned by whoever made it:
// `.staging-…` a harvest before its publish, `.claimed-…` an entry a taker or a
// delete took. An entry is only ever TAKEN by renaming it to a claimed name — the
// rename is exclusive, so two takers, or a taker and a delete, are told apart by
// it, and a taker can never move an entry an `rm -rf` is half-way through.

/**
 * A transient name older than this was left by a process that died holding it
 * (a crashed harvest or take, a killed delete); the sweep deletes it. A live
 * delete is never raced: an entry is deleted only by `sweep`, inside the
 * reaper's sweep, one sweep at a time (its job-wide lock), so a claimed name a
 * sweep finds is never one a delete is still working on.
 */
const TRANSIENT_GRACE_MS = 60 * 60_000;

// Deleting an entry is a whole store or tree (~75k / ~23k entries): 5–50 s
// measured. Counted in awake time (spawnCaptured's deadline), so a machine
// dozing through the delete does not time it out.
const POOL_RM_TIMEOUT_MS = 30 * 60_000;

const STAGING_PREFIX = ".staging-";
const CLAIMED_PREFIX = ".claimed-";

export interface RenamePool {
  /** What the pool holds, for its log lines ("dependency store", "tree"). */
  what: string;
  dir: string;
  /** Older than this, a published entry is deleted by `sweep` instead of taken. */
  maxAgeMs: number;
}

// The time a name was made, from its leading `<ms>-` (after any transient
// prefix): a rename keeps a dir's own mtime, so the time rides in the name.
export function madeAtMs(name: string): number | undefined {
  const bare = [STAGING_PREFIX, CLAIMED_PREFIX].reduce(
    (n, p) => (n.startsWith(p) ? n.slice(p.length) : n),
    name,
  );
  const m = /^(\d+)-/.exec(bare);
  return m ? Number(m[1]) : undefined;
}

const isPublished = (name: string): boolean =>
  !name.startsWith(".") && madeAtMs(name) !== undefined;

/**
 * Publish an entry named `entry`: `fill(staging)` writes its payload into a
 * fresh staging dir, and one rename publishes it — so a taker never sees an
 * entry without its payload. A `fill` that throws leaves the staging dir for
 * the sweep (its contents may be half-moved, so nothing here guesses).
 */
export async function publishEntry(
  pool: RenamePool,
  entry: string,
  fill: (staging: string) => Promise<void>,
): Promise<void> {
  const staging = join(pool.dir, `${STAGING_PREFIX}${entry}`);
  await mkdir(staging, { recursive: true });
  await fill(staging);
  await rename(staging, join(pool.dir, entry));
}

/** One entry this process took: its claimed dir, now only its own. */
export interface TakenEntry {
  entry: string;
  ageMs: number;
  claimed: string;
}

/**
 * Take the newest entry within the age bound for this process (claimed by
 * rename); null when nothing waits, or every one was taken first. The caller
 * moves the payload out of `claimed` and then calls `release` — or `putBack`
 * when it could not use it.
 */
export async function takeNewest(
  pool: RenamePool,
  now: number,
): Promise<TakenEntry | null> {
  for (const entry of await listPublished(pool.dir)) {
    const ageMs = now - madeAtMs(entry)!;
    if (ageMs > pool.maxAgeMs) continue; // sweep deletes it
    const claimed = await claim(pool.dir, entry, now);
    if (claimed !== null) return { entry, ageMs, claimed };
  }
  return null;
}

/** Whether any published entry within the age bound still waits. */
export async function hasWaiting(
  pool: RenamePool,
  now: number,
): Promise<boolean> {
  return (await listPublished(pool.dir)).some(
    (entry) => now - madeAtMs(entry)! <= pool.maxAgeMs,
  );
}

/** Whether `entry` is still published under its own name (nobody has claimed it). */
export async function isStillPublished(
  pool: RenamePool,
  entry: string,
): Promise<boolean> {
  return (await listNames(pool.dir)).includes(entry);
}

/**
 * A fresh transient name in the pool for a payload this process is still
 * writing; the sweep deletes it once its grace has passed (a crashed writer).
 */
export function transientPath(
  pool: RenamePool,
  label: string,
  now: number,
): string {
  return join(pool.dir, `${STAGING_PREFIX}${now}-${label}-${randomUUID()}`);
}

/** Give a taken entry back to the pool under its published name. */
export async function putBack(
  pool: RenamePool,
  taken: TakenEntry,
): Promise<void> {
  await rename(taken.claimed, join(pool.dir, taken.entry));
}

/**
 * Delete what should not wait any more: published entries past the age bound,
 * and transient names a dead process left. Called by the reaper once per
 * sweep, beside the trash. Returns how many it deleted.
 */
export async function sweep(pool: RenamePool, now: number): Promise<number> {
  let deleted = 0;
  for (const name of await listNames(pool.dir)) {
    const at = madeAtMs(name);
    if (isPublished(name)) {
      if (now - at! <= pool.maxAgeMs) continue;
      const claimed = await claim(pool.dir, name, now);
      // A taker got it first.
      if (claimed === null) continue;
      await deletePath(pool, claimed);
      deleted++;
      continue;
    }
    // A transient or foreign name: past the grace, nobody alive owns it.
    if (at !== undefined && now - at <= TRANSIENT_GRACE_MS) continue;
    await deletePath(pool, join(pool.dir, name));
    deleted++;
  }
  return deleted;
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Published entries, newest first. */
async function listPublished(dir: string): Promise<string[]> {
  return (await listNames(dir))
    .filter(isPublished)
    .sort((a, b) => madeAtMs(b)! - madeAtMs(a)!);
}

/**
 * Take `entry` for this process: rename it to a claimed name only this call
 * knows. Null when someone else took it first. The claimed name carries the
 * CLAIM's time (`.claimed-<now>-<entry>-<uuid>`), not the entry's: the sweep
 * reads a transient name's age as how long its owner has held it, and an
 * entry is usually older than the grace when it is taken.
 */
async function claim(
  dir: string,
  entry: string,
  now: number,
): Promise<string | null> {
  const claimed = join(dir, `${CLAIMED_PREFIX}${now}-${entry}-${randomUUID()}`);
  try {
    await rename(join(dir, entry), claimed);
    return claimed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Background tier, like a trash entry's delete; logged, not thrown, for the
// same reason: what is left is disk space under a claimed name, which the next
// `sweep` deletes once its grace has passed.
export async function deletePath(
  pool: RenamePool,
  path: string,
): Promise<void> {
  const r = await spawnCaptured(["rm", "-rf", path], {
    tier: "background",
    timeoutMs: POOL_RM_TIMEOUT_MS,
  });
  if (r.timedOut || r.exitCode !== 0) {
    console.warn(
      `[worktree] deleting pooled ${pool.what} ${path} did not finish ` +
        `(${r.timedOut ? `timed out after ${POOL_RM_TIMEOUT_MS} ms` : `exit ${r.exitCode}`}): ` +
        `${r.stderr.trim() || "<no stderr>"} — the next sweep retries it`,
    );
  }
}
