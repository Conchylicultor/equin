import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  flockRelease,
  flockTry,
  flockTryShared,
} from "@plugins/packages/plugins/flock/core";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// A directory of things a removed checkout leaves for the next checkout — its
// dependency store (dep-store-pool.ts), its tracked tree (tree-pool.ts) —
// every move in it one `rename` on the same volume.
//
// THE NAMES.
// - `<ms>-<checkout>` is a published entry (a dir holding the pool's own
//   payload), `<ms>` the instant it was PUBLISHED (stamped at the publishing
//   rename, never earlier: a harvest that walked its payload for a minute must
//   not publish an entry older than ones published meanwhile).
// - `seed` (a SEEDED pool only) is the pool's seed: an entry that is never
//   taken, only read in place — copied by whoever needs one. It is a fixed
//   name, so the seed is a fact of the directory, not something each caller
//   works out from its own clock: it is made only by a rename onto `seed`,
//   which fails while one exists (a dir renamed onto a non-empty dir), and
//   unmade only by the sweep, under `seed.lock` (below). Its `entry` file
//   holds the published name it had (its age).
// - `seed.lock` is the seed's readers' lock: every reader holds it SHARED for
//   as long as it reads the seed; the sweep retires a seed only once it takes
//   it EXCLUSIVE — so a seed is never moved from under a copy in flight. A
//   stable file, never deleted, so a reader's lock and the sweep's are always
//   on the same inode.
// - Every dot-name is transient and owned by whoever made it: `.staging-…` a
//   payload being written (a harvest before its publish, a seed's copy),
//   `.claimed-…` an entry a taker or a delete took. An entry is only ever TAKEN
//   by renaming it to a claimed name — the rename is exclusive, so two takers,
//   or a taker and a delete, are told apart by it, and a taker can never move
//   an entry an `rm -rf` is half-way through. A `.staging-…` dir holds its
//   writer's flock on its `.owner` file for as long as it is written: the sweep
//   deletes a transient only once nobody holds it, however long ago it was
//   made — a copy that outlives the grace (a machine asleep mid-`cp`) is never
//   deleted under its writer.

/**
 * A transient name older than this, whose owner lock (if it has one) is free,
 * was left by a process that died holding it (a crashed harvest or take, a
 * killed delete); the sweep deletes it. A live delete is never raced: an entry
 * is deleted only by `sweep`, inside the reaper's sweep, one sweep at a time
 * (its job-wide lock), so a claimed name a sweep finds is never one a delete
 * is still working on. The grace covers a `.claimed-…` (made by a rename, it
 * cannot carry a lock of its own) and a `.staging-…` between its mkdir and its
 * lock.
 */
const TRANSIENT_GRACE_MS = 60 * 60_000;

// Deleting an entry is a whole store or tree (~75k / ~23k entries): 5–50 s
// measured. Counted in awake time (spawnCaptured's deadline), so a machine
// dozing through the delete does not time it out.
const POOL_RM_TIMEOUT_MS = 30 * 60_000;

const STAGING_PREFIX = ".staging-";
const CLAIMED_PREFIX = ".claimed-";
const OWNER_FILE = ".owner";
const SEED_NAME = "seed";
const SEED_LOCK_NAME = "seed.lock";
const SEED_ENTRY_FILE = "entry";

export interface RenamePool {
  /** What the pool holds, for its log lines ("dependency store", "tree"). */
  what: string;
  dir: AppPath;
  /** Older than this, a published entry (or the seed) is deleted by `sweep` instead of taken. */
  maxAgeMs: number;
  /**
   * Whether the pool keeps a seed: an entry never taken, read in place
   * (`holdSeed`). A publish makes its entry the seed when there is none, and
   * the sweep promotes the newest entry when it retired one.
   */
  seeded: boolean;
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

const isRenameTargetTaken = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY" || code === "EEXIST";
};

/** A transient dir this process is writing, held by its `.owner` lock. */
export interface HeldTransient {
  path: AppPath;
  /** Delete the dir (whatever is left in it), then let go of its lock. */
  discard(): Promise<void>;
  /** Let go of the lock, leaving the dir as it is (moved away, or the sweep's). */
  release(): void;
}

/**
 * A fresh transient dir in the pool for a payload this process is still
 * writing, locked by its owner: the sweep never deletes it while this process
 * holds it (`discard`, or the process dying, lets go).
 */
export async function holdTransient(
  pool: RenamePool,
  label: string,
  now: number,
): Promise<HeldTransient> {
  const path = joinAppPath(
    pool.dir,
    `${STAGING_PREFIX}${now}-${label}-${randomUUID()}`,
  );
  await mkdir(path, { recursive: true });
  const owner = await openOwnedFd(joinAppPath(path, OWNER_FILE), "a");
  // A fresh file only this call knows: nobody else can hold its lock.
  if (!flockTry(owner.fd)) {
    owner.close();
    throw new Error(`could not lock the fresh transient dir ${path}`);
  }
  return {
    path,
    discard: async () => {
      try {
        await deletePath(pool, path);
      } finally {
        owner.close();
      }
    },
    release: () => owner.close(),
  };
}

/**
 * Publish an entry labelled `label`: `fill(staging)` writes its payload into a
 * fresh, owned staging dir, and one rename publishes it — so a taker never
 * sees an entry without its payload. The entry's name is stamped with
 * `clock()` at that rename. In a seeded pool with no seed, the entry becomes
 * the seed. A `fill` that throws leaves the staging dir (unlocked) for the
 * sweep: its contents may be half-moved, so nothing here guesses.
 */
export async function publishEntry(
  pool: RenamePool,
  label: string,
  clock: () => number,
  fill: (staging: string) => Promise<void>,
): Promise<{ entry: string; seed: boolean }> {
  const staging = await holdTransient(pool, `publish-${label}`, clock());
  try {
    await fill(staging.path);
  } catch (err) {
    // Left for the sweep, unowned; its grace counts from its name.
    staging.release();
    throw err;
  }
  const entry = `${clock()}-${label}`;
  // Still owned through the publishing rename: a sweep that finds the staging
  // dir past its grace (a machine asleep since its mkdir) must not start an
  // `rm -rf` the rename would then carry under the published name.
  let published: AppPath;
  try {
    published = joinAppPath(pool.dir, entry);
    if (pool.seeded) {
      await writeFile(join(staging.path, SEED_ENTRY_FILE), entry);
      try {
        await rename(staging.path, joinAppPath(pool.dir, SEED_NAME));
        published = joinAppPath(pool.dir, SEED_NAME);
      } catch (err) {
        if (!isRenameTargetTaken(err)) throw err;
        await unlink(join(staging.path, SEED_ENTRY_FILE));
        await rename(staging.path, published);
      }
    } else {
      await rename(staging.path, published);
    }
  } finally {
    // After a failure, what is left is the sweep's.
    staging.release();
  }
  // The owner file is the staging dir's, not the entry's. A taker may have
  // claimed the entry already: the file then goes with it, inert.
  try {
    await unlink(joinAppPath(published, OWNER_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { entry, seed: published.endsWith(`/${SEED_NAME}`) };
}

/** One entry this process took: its claimed dir, now only its own. */
export interface TakenEntry {
  entry: string;
  ageMs: number;
  claimed: string;
}

/**
 * Take the newest published entry within the age bound for this process
 * (claimed by rename); null when nothing waits, or every one was taken first.
 * Never the seed: it is not a published entry. The caller moves the payload
 * out of `claimed` — or calls `putBack` when it could not use it.
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

/** The seed, held for reading: it cannot move until `release`. */
export interface HeldSeed {
  /** The published name it had. */
  entry: string;
  /** When it was published (from `entry`). */
  madeAt: number;
  /** The seed's dir (its payload inside it). */
  path: AppPath;
  release(): void;
}

/**
 * Hold the pool's seed for reading: null when there is none — or when the
 * sweep is retiring it at this instant (it holds the lock exclusive only
 * across its rename). While held, nothing moves or deletes the seed: the sweep
 * retires one only under the exclusive lock, and nothing else renames it.
 * Age is not judged here — the seed is the seed until the sweep retires it.
 */
export async function holdSeed(pool: RenamePool): Promise<HeldSeed | null> {
  let lock: OwnedFd;
  try {
    lock = await openOwnedFd(joinAppPath(pool.dir, SEED_LOCK_NAME), "a");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // no pool dir
    throw err;
  }
  if (!flockTryShared(lock.fd)) {
    lock.close();
    return null;
  }
  const path = joinAppPath(pool.dir, SEED_NAME);
  let entry: string;
  try {
    entry = (await readFile(join(path, SEED_ENTRY_FILE), "utf8")).trim();
  } catch (err) {
    lock.close();
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // no seed
    throw err;
  }
  const madeAt = madeAtMs(entry);
  if (madeAt === undefined) {
    lock.close();
    throw new Error(
      `the ${pool.what} pool's seed names no entry time: ${JSON.stringify(entry)}`,
    );
  }
  return {
    entry,
    madeAt,
    path,
    release: () => {
      flockRelease(lock.fd);
      lock.close();
    },
  };
}

/** Give a taken entry back to the pool under its published name. */
export async function putBack(
  pool: RenamePool,
  taken: TakenEntry,
): Promise<void> {
  await rename(taken.claimed, joinAppPath(pool.dir, taken.entry));
}

/**
 * Delete what should not wait any more: published entries past the age bound,
 * the seed past it once no reader holds it, and transient names a dead process
 * left. Then, in a seeded pool left without a seed, promote the newest entry
 * within the bound. Called by the reaper once per sweep, beside the trash.
 * Returns how many it deleted.
 */
export async function sweep(pool: RenamePool, now: number): Promise<number> {
  let deleted = 0;
  for (const name of await listNames(pool.dir)) {
    if (name === SEED_LOCK_NAME) continue;
    if (name === SEED_NAME) {
      if (await retireSeedIfExpired(pool, now)) deleted++;
      continue;
    }
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
    // A transient or foreign name: past the grace, and its owner (if it has
    // one) gone, nobody alive owns it.
    if (at !== undefined && now - at <= TRANSIENT_GRACE_MS) continue;
    const path = joinAppPath(pool.dir, name);
    const owner = await takeOwner(path);
    if (owner === "held") continue;
    try {
      await deletePath(pool, path);
    } finally {
      owner?.close();
    }
    deleted++;
  }
  if (pool.seeded) await promoteSeed(pool, now);
  return deleted;
}

/**
 * The owner lock of the transient dir `path`, taken: null when it has none (a
 * claimed name, a dir from before owner locks, a foreign file), "held" when
 * its writer is alive.
 */
async function takeOwner(path: AppPath): Promise<OwnedFd | "held" | null> {
  let fd: OwnedFd;
  try {
    // "r": never create one — a dir without an owner file has no owner.
    fd = await openOwnedFd(joinAppPath(path, OWNER_FILE), "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  if (flockTry(fd.fd)) return fd;
  fd.close();
  return "held";
}

/** Retire the seed when it is past the age bound and no reader holds it. */
async function retireSeedIfExpired(
  pool: RenamePool,
  now: number,
): Promise<boolean> {
  const seed = joinAppPath(pool.dir, SEED_NAME);
  let entry: string | null;
  try {
    entry = (await readFile(join(seed, SEED_ENTRY_FILE), "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    entry = null;
  }
  const at = entry === null ? undefined : madeAtMs(entry);
  if (at === undefined) {
    // Never made by this code (every seed gets its `entry` before its
    // rename): said out loud, and retired like an expired one, so one broken
    // dir cannot stop every later sweep — and the reaper's — for good.
    console.warn(
      `[worktree] the ${pool.what} pool's seed names no entry time ` +
        `(${entry === null ? "no entry file" : JSON.stringify(entry)}): retiring it`,
    );
  } else if (now - at <= pool.maxAgeMs) {
    return false;
  }
  const lock = await openOwnedFd(joinAppPath(pool.dir, SEED_LOCK_NAME), "a");
  let claimed: string;
  try {
    // A copy in flight: the next sweep retires it.
    if (!flockTry(lock.fd)) return false;
    claimed = join(
      pool.dir,
      `${CLAIMED_PREFIX}${now}-${SEED_NAME}-${randomUUID()}`,
    );
    await rename(seed, claimed);
  } finally {
    lock.close();
  }
  await deletePath(pool, claimed);
  return true;
}

/**
 * Make the newest entry within the age bound the seed, when there is none:
 * claimed like any take, then renamed onto `seed` — which fails if a publish
 * made one meanwhile, and the entry goes back.
 */
async function promoteSeed(pool: RenamePool, now: number): Promise<void> {
  if ((await listNames(pool.dir)).includes(SEED_NAME)) return;
  const taken = await takeNewest(pool, now);
  if (taken === null) return;
  const entryFile = join(taken.claimed, SEED_ENTRY_FILE);
  await writeFile(entryFile, taken.entry);
  try {
    await rename(taken.claimed, joinAppPath(pool.dir, SEED_NAME));
  } catch (err) {
    if (!isRenameTargetTaken(err)) throw err;
    await unlink(entryFile);
    await putBack(pool, taken);
  }
}

async function listNames(dir: AppPath): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Published entries, newest first. */
async function listPublished(dir: AppPath): Promise<string[]> {
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
  dir: AppPath,
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
// same reason: what is left is disk space under a transient name, which the
// next `sweep` deletes once its grace has passed.
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
