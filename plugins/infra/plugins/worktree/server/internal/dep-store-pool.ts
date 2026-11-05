import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, rename, rm } from "node:fs/promises";
import { lstat, readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// A removed checkout's installed dependency store, handed to the next checkout
// instead of being deleted while that checkout installs one from scratch.
//
// WHY. A cold `bun install` of this repo writes its store by `clonefile(2)`-ing
// every package directory out of bun's global cache (1,106 of them, 75k
// entries). A directory clone holds the volume's rename lock for as long as it
// runs, so every `rename` on the disk — main's `writeAtomic`, `cloneNamedBinary`
// — waits behind it: measured 2026-11-05, a probe renaming in a disjoint dir was
// held 183–542 ms by each of three warm-cache installs (1.9 s by a foreground
// one), and 6–32 ms by the same install with any non-directory-clone backend.
// It ran ~100 times a day (a spare refill or a cold add per launch), each
// followed days later by an `rm -rf` of the same 75k entries at reap. Reusing
// the store makes both rare: the next install re-links it, cloning only what
// the lock changed (1 package, 0.7–2 s, against a 4-day-old store), and the
// result is the clean install's tree entry for entry.
// research/2026-11-05-global-bulk-tree-mutations-rename-lock.md.
//
// ONLY THE STORE (`node_modules/.bun`, the isolated linker's content-addressed
// `<name>@<version>` dirs) moves. Everything else in `node_modules` — the
// top-level links, `.bin`, and every workspace-local `node_modules` — is links
// bun recreates, and bun never prunes a top-level entry the lock no longer
// names (measured), so carrying them over could keep a removed dependency
// resolvable. A store entry nothing links to is inert, and bun re-links each
// entry's own dependency links on every install (measured: a planted stale
// link was repaired).
//
// THE POOL'S NAMES. `<ms>-<checkout>` is a published entry (its `store` inside);
// every dot-name is transient and owned by whoever made it: `.staging-…` a
// harvest before its publish, `.claimed-…` an entry an adopter or a delete took.
// An entry is only ever TAKEN by renaming it to a claimed name — the rename is
// exclusive, so an adopter can never move a store a delete is half-way through.

const STORE_REL = join("node_modules", ".bun");
const NODE_MODULES = "node_modules";
// `ensureDeps`' stamp (bootstrap's STAMP_REL — a `cli` barrel this server code
// may not import): written once an install has fully succeeded, so its presence
// is "this store is complete", and its mtime is when it was last made correct.
const STAMP_REL = join("node_modules", ".equin-deps");

/**
 * How many harvested stores wait at once. Checkouts are made faster than they
 * are removed (~100 vs ~67 a day on 2026-11-04), so the pool is normally empty
 * or one deep; the bound only matters when removals bunch up (a bulk delete),
 * where the oldest past it is deleted as before.
 */
const POOL_MAX = 2;

/**
 * Older than this, a waiting store is deleted rather than adopted: it has
 * drifted far enough behind `main` that its re-link clones much of what a cold
 * install would.
 */
const POOL_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * A transient name older than this was left by a process that died holding it
 * (a crashed harvest or adopt, a killed delete); the sweep deletes it. Above
 * the delete's own timeout, so a live delete is never raced.
 */
const TRANSIENT_GRACE_MS = 60 * 60_000;

// Deleting a store is ~75k entries, like a trash entry's node_modules.
const POOL_RM_TIMEOUT_MS = 30 * 60_000;

const STAGING_PREFIX = ".staging-";
const CLAIMED_PREFIX = ".claimed-";
const STORE_DIR = "store";

/** Where harvested stores wait: beside the worktree trash, on the same volume, so every move is one `rename`. */
export function depStorePoolDir(repoRoot: AppPath): AppPath {
  return joinAppPath(repoRoot, ".claude", "worktree-dep-stores");
}

// The time a name was made, from its leading `<ms>-` (after any transient
// prefix): a rename keeps a dir's own mtime, so the time rides in the name.
function madeAtMs(name: string): number | undefined {
  const bare = [STAGING_PREFIX, CLAIMED_PREFIX].reduce(
    (n, p) => (n.startsWith(p) ? n.slice(p.length) : n),
    name,
  );
  const m = /^(\d+)-/.exec(bare);
  return m ? Number(m[1]) : undefined;
}

const isPublished = (name: string): boolean =>
  !name.startsWith(".") && madeAtMs(name) !== undefined;

export type HarvestResult =
  | { kind: "harvested"; entry: string }
  | { kind: "skipped"; why: string }
  /** The harvest itself threw; the store is deleted with the checkout. */
  | { kind: "failed"; error: string };

/**
 * The first store entry changed after `sinceMs`, store-relative; null when none.
 * A file edited in place under a package (a debugging patch) is the one change
 * bun's re-link would not undo — it trusts an existing `<name>@<version>` dir —
 * so a store with one is not handed on. Stops at the first.
 *
 * Not caught: an edit followed by a later successful install in the same
 * checkout, which rewrites the stamp after it. Only content hashes would see
 * that; the store is the one the checkout itself was running on.
 */
async function firstChangedEntry(
  store: string,
  sinceMs: number,
): Promise<string | null> {
  const dirs = [store];
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if ((await lstat(path)).mtimeMs > sinceMs) {
        return path.slice(store.length + 1);
      }
      if (entry.isDirectory()) dirs.push(path);
    }
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

/**
 * Move `checkout`'s dependency store into the pool, for `adoptDepStore` to hand
 * the next checkout. `checkout` is a removed checkout (a trash entry), so
 * nothing else touches it. Skipped — the store is then deleted with the rest of
 * the checkout, as before — when it may not be what its install made: no
 * stamp (the install never finished), or an entry changed since the stamp.
 *
 * Never throws: the removal it follows is already committed (the checkout is
 * out of `.claude/worktrees/` and git), so a failure here is reported as a
 * result for the caller to log, and costs only the reuse.
 */
export async function harvestDepStore(
  repoRoot: AppPath,
  checkout: string,
  now: number,
): Promise<HarvestResult> {
  try {
    return await harvest(repoRoot, checkout, now);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { kind: "failed", error: err.message };
  }
}

async function harvest(
  repoRoot: AppPath,
  checkout: string,
  now: number,
): Promise<HarvestResult> {
  const store = join(checkout, STORE_REL);
  if (!(await exists(store))) {
    return { kind: "skipped", why: "no dependency store" };
  }
  let stampMs: number;
  try {
    stampMs = (await stat(join(checkout, STAMP_REL))).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { kind: "skipped", why: "no install stamp" };
  }
  // A second of slack: the stamp is written right after the install's last write.
  const changed = await firstChangedEntry(store, stampMs + 1000);
  if (changed !== null) {
    return { kind: "skipped", why: `changed after its install: ${changed}` };
  }

  const pool = depStorePoolDir(repoRoot);
  const entry = `${now}-${basename(checkout)}`;
  // Staged then published by one rename, so an adopter never sees an entry
  // without its store.
  const staging = join(pool, `${STAGING_PREFIX}${entry}`);
  await mkdir(staging, { recursive: true });
  await rename(store, join(staging, STORE_DIR));
  await rename(staging, join(pool, entry));
  for (const old of (await listPublished(pool)).slice(POOL_MAX)) {
    await deleteEntry(pool, old, now);
  }
  return { kind: "harvested", entry };
}

export type AdoptResult =
  | { kind: "adopted"; entry: string; ageMs: number }
  /** The checkout already has a `node_modules`: its own tree is newer than anything waiting. */
  | { kind: "present" }
  /** Nothing waiting (or every entry was taken first): the install is a cold one. */
  | { kind: "none" };

/**
 * Give `checkout` the newest waiting store as its `node_modules/.bun`, before
 * its install runs: the install then re-links it and clones only what the lock
 * changed. A no-op for a checkout that already has a `node_modules` (a claimed
 * spare, a resumed checkout).
 *
 * An entry is taken by renaming it to a claimed name first: two adopters, or
 * an adopter and a delete, are told apart by that rename — the loser's source
 * is gone (ENOENT) and it tries the next entry.
 */
export async function adoptDepStore(
  repoRoot: AppPath,
  checkout: string,
  now: number,
): Promise<AdoptResult> {
  if (await exists(join(checkout, NODE_MODULES))) return { kind: "present" };
  const pool = depStorePoolDir(repoRoot);
  for (const entry of await listPublished(pool)) {
    const ageMs = now - madeAtMs(entry)!;
    if (ageMs > POOL_MAX_AGE_MS) continue; // emptyDepStorePool deletes it
    const claimed = await claim(pool, entry, now);
    if (claimed === null) continue;
    try {
      await mkdir(join(checkout, NODE_MODULES));
      await rename(join(claimed, STORE_DIR), join(checkout, STORE_REL));
    } catch (err) {
      // Unexpected (the checkout vanished, or grew a node_modules since the
      // check): the store goes back to the pool, and the install fails loudly.
      await rename(claimed, join(pool, entry));
      throw err;
    }
    await rm(claimed, { recursive: true, force: true });
    return { kind: "adopted", entry, ageMs };
  }
  return { kind: "none" };
}

/**
 * Delete what should not wait any more: published entries past the age bound,
 * and transient names a dead process left. Called by the reaper once per
 * sweep, beside the trash. Returns how many it deleted.
 */
export async function emptyDepStorePool(
  repoRoot: AppPath,
  now: number,
): Promise<number> {
  const pool = depStorePoolDir(repoRoot);
  let deleted = 0;
  for (const name of await listNames(pool)) {
    const at = madeAtMs(name);
    if (isPublished(name)) {
      if (now - at! <= POOL_MAX_AGE_MS) continue;
      if (await deleteEntry(pool, name, now)) deleted++;
      continue;
    }
    // A transient or foreign name: past the grace, nobody alive owns it.
    if (at !== undefined && now - at <= TRANSIENT_GRACE_MS) continue;
    await deletePath(join(pool, name));
    deleted++;
  }
  return deleted;
}

async function listNames(pool: string): Promise<string[]> {
  try {
    return await readdir(pool);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Published entries, newest first. */
async function listPublished(pool: string): Promise<string[]> {
  return (await listNames(pool))
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
  pool: string,
  entry: string,
  now: number,
): Promise<string | null> {
  const claimed = join(
    pool,
    `${CLAIMED_PREFIX}${now}-${entry}-${randomUUID()}`,
  );
  try {
    await rename(join(pool, entry), claimed);
    return claimed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Claim then delete; false when an adopter or another delete took it first. */
async function deleteEntry(
  pool: string,
  entry: string,
  now: number,
): Promise<boolean> {
  const claimed = await claim(pool, entry, now);
  if (claimed === null) return false;
  await deletePath(claimed);
  return true;
}

// Background tier, like a trash entry's delete; logged, not thrown, for the
// same reason: what is left is disk space under a claimed name, which the next
// `emptyDepStorePool` deletes once its grace has passed.
async function deletePath(path: string): Promise<void> {
  const r = await spawnCaptured(["rm", "-rf", path], {
    tier: "background",
    timeoutMs: POOL_RM_TIMEOUT_MS,
  });
  if (r.timedOut || r.exitCode !== 0) {
    console.warn(
      `[worktree] deleting pooled dependency store ${path} did not finish ` +
        `(${r.timedOut ? `timed out after ${POOL_RM_TIMEOUT_MS} ms` : `exit ${r.exitCode}`}): ` +
        `${r.stderr.trim() || "<no stderr>"} — the next emptyDepStorePool retries it`,
    );
  }
}

/** One line for a job's log: what a checkout's install started from. */
export function describeAdoption(r: AdoptResult): string {
  switch (r.kind) {
    case "adopted":
      return `dependency store adopted from ${r.entry} (harvested ${Math.round(r.ageMs / 60_000)} min ago)`;
    case "present":
      return "dependency store already in place";
    case "none":
      return "no dependency store waiting — cold install";
  }
}

/** One line for a job's log: what became of a removed checkout's store. */
export function describeHarvest(r: HarvestResult): string {
  switch (r.kind) {
    case "harvested":
      return `dependency store kept for the next checkout (${r.entry})`;
    case "skipped":
      return `dependency store deleted with the checkout — ${r.why}`;
    case "failed":
      return `dependency store deleted with the checkout — keeping it FAILED: ${r.error}`;
  }
}
