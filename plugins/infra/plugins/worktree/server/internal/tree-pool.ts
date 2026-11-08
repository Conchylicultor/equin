import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { rename, rmdir } from "node:fs/promises";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { basename, join } from "node:path";
import {
  deletePath,
  publishEntry,
  putBack,
  type RenamePool,
  sweep,
  takeNewest,
} from "./rename-pool";

// A removed checkout's working tree — its tracked files and its git index —
// handed to the next checkout instead of being deleted while that checkout
// writes every tracked file again.
//
// WHY. Writing a checkout is ~23k files (~33k file-system events), and the
// reap deletes the same files 72 h later. Every event goes through fseventsd,
// which on this machine sits at one core under load and delivers every folder
// watch late (p99 11–39 s) while it queues
// (research/2026-11-08-global-fseventsd-event-volume.md): one checkout was
// ~45k events, and one was made per launch — 80–130 a day, a quarter to a half
// of the machine's events in a busy hour. The spare pool does not change that
// (each spare is one launch's checkout, made early: 46 written / 46 claimed on
// 11-08); what a checkout STARTS from does.
//
// A reaped tree is ~3 days behind `main`: 2.8k of 23k tracked files differ
// (measured on 11-08, a tree from 76 h earlier). `addCheckout` moves it into
// place with its own index and runs the same `git reset --hard` an empty
// checkout runs: git compares each index entry's stat data with the file and
// rewrites only the files whose content differs from the target (2,771
// written, 1.1 s, against 23,165 and 5.1 s), then `git clean -ffdx` deletes
// everything untracked or ignored — what the old agent left, and the
// `node_modules` links its store's harvest left behind. The result is the
// target tree exactly, as a fresh checkout's is.
//
// WHY THE INDEX TOO. Without it git has no stat data to trust, and a reset
// writes every file again. It is valid only beside the tree it describes —
// same inodes, mtimes, ctimes — which a `rename` keeps, so the tree and its
// index travel together, as one entry, and nothing writes into the tree in
// between (the dependency-store harvest only moves `node_modules/.bun`, which
// git does not track).
//
// HOW MANY WAIT: every one harvested, until it ages out, for the dependency
// store's reason (dep-store-pool.ts): supply is demand, 72 h late, and launches
// swing 3 → 88 a day. A waiting tree costs ~170 MB on disk (its files are its
// own, not clones) — the disk the same checkout held while it waited for its
// reap. The age bound is shorter than the store's: the diff a tree carries
// grows with its age (24 h: 1.6k files, 72 h: 2.8k, 96 h: 4.8k), and a
// reaped tree is already 3 days old.

const TREE_DIR = "tree";
const INDEX_FILE = "index";

/**
 * Older than this (in the pool, on top of the ~72 h the checkout lived), a
 * waiting tree is deleted rather than adopted.
 */
const TREE_POOL_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/** Where harvested trees wait: beside the worktree trash, on the same volume, so every move is one `rename`. */
export function treePoolDir(repoRoot: AppPath): AppPath {
  return joinAppPath(repoRoot, ".claude", "worktree-trees");
}

function treePool(repoRoot: AppPath): RenamePool {
  return {
    what: "tree",
    dir: treePoolDir(repoRoot),
    maxAgeMs: TREE_POOL_MAX_AGE_MS,
  };
}

/**
 * The name the index of the trash entry at `trashPath` is kept under until
 * its harvest: a sibling, so a tracked file of the same name can never collide
 * with it, and its `<ms>-` prefix makes it a trash entry `emptyWorktreeTrash`
 * deletes like any other once its grace has passed.
 */
export function trashedIndexPath(trashPath: string): string {
  return `${trashPath}.index`;
}

export type TreeHarvestResult =
  | { kind: "harvested"; entry: string }
  | { kind: "skipped"; why: string }
  /** The harvest itself threw; the tree is deleted with the rest of the trash entry. */
  | { kind: "failed"; error: string };

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
 * Move a removed checkout's tree (`trashPath`, a trash entry nothing else
 * touches) and its index (kept at `trashedIndexPath`) into the pool, for
 * `takeTree` to hand the next checkout. Run after the dependency store's
 * harvest. Skipped — both are then deleted with the trash entry, as before —
 * when there is no index (the checkout was never written, or its admin entry
 * had none).
 *
 * Never throws: the removal it follows is already committed, so a failure is a
 * result for the caller to log, and costs only the reuse.
 */
export async function harvestTree(
  repoRoot: AppPath,
  trashPath: string,
  now: number,
): Promise<TreeHarvestResult> {
  try {
    const index = trashedIndexPath(trashPath);
    if (!(await exists(index))) {
      return { kind: "skipped", why: "no git index" };
    }
    const pool = treePool(repoRoot);
    // A store its own harvest refused (an entry edited after its install) is
    // ~75k entries `git clean` would otherwise delete on a launch's path:
    // deleted here, at the reap, where the whole tree used to be.
    const nodeModules = join(trashPath, "node_modules");
    if (await exists(join(nodeModules, ".bun"))) {
      await deletePath(pool, nodeModules);
    }
    const entry = `${now}-${basename(trashPath).replace(/^\d+-/, "")}`;
    await publishEntry(pool, entry, async (staging) => {
      await rename(index, join(staging, INDEX_FILE));
      await rename(trashPath, join(staging, TREE_DIR));
    });
    return { kind: "harvested", entry };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { kind: "failed", error: err.message };
  }
}

/** A tree this process took from the pool, and where its index is. */
export interface TakenTree {
  entry: string;
  ageMs: number;
  tree: string;
  index: string;
  /** Done with it (its tree and index moved out): drop the empty claimed dir. */
  release(): Promise<void>;
  /** Could not use it: give it back, whole, to the pool. */
  putBack(): Promise<void>;
}

/**
 * Take the newest waiting tree (claimed by rename, so two takers never get the
 * same one); null when none waits. The caller moves `tree` and `index` out,
 * then calls `release`.
 */
export async function takeTree(
  repoRoot: AppPath,
  now: number,
): Promise<TakenTree | null> {
  const pool = treePool(repoRoot);
  const taken = await takeNewest(pool, now);
  if (taken === null) return null;
  return {
    entry: taken.entry,
    ageMs: taken.ageMs,
    tree: join(taken.claimed, TREE_DIR),
    index: join(taken.claimed, INDEX_FILE),
    release: () => rmdir(taken.claimed),
    putBack: () => putBack(pool, taken),
  };
}

/**
 * Delete trees past the age bound and transient names a dead process left.
 * Called by the reaper once per sweep, beside the trash.
 */
export function emptyTreePool(repoRoot: AppPath, now: number): Promise<number> {
  return sweep(treePool(repoRoot), now);
}

/** What a new checkout's files started from (`addCheckout`). */
export type TreeStart =
  /** A removed checkout's tree: only the files that differ were written. */
  | { kind: "recycled"; entry: string; ageMs: number }
  /** An empty dir: every file written. `recycleFailed` when a taken tree could not be brought to the target (it was discarded). */
  | { kind: "empty"; recycleFailed?: string }
  /** The caller asked for an empty start (`recycle: false`). */
  | { kind: "not-asked" };

/** One line for a job's log: what a checkout's files started from. */
export function describeTreeStart(r: TreeStart): string {
  switch (r.kind) {
    case "recycled":
      return `tree recycled from ${r.entry} (harvested ${Math.round(r.ageMs / 60_000)} min ago)`;
    case "empty":
      return r.recycleFailed === undefined
        ? "no tree waiting — every file written"
        : `recycling a tree FAILED, every file written: ${r.recycleFailed}`;
    case "not-asked":
      return "every file written";
  }
}

/** One line for a job's log: what became of a removed checkout's tree. */
export function describeTreeHarvest(r: TreeHarvestResult): string {
  switch (r.kind) {
    case "harvested":
      return `tree kept for the next checkout (${r.entry})`;
    case "skipped":
      return `tree deleted — ${r.why}`;
    case "failed":
      return `tree deleted — keeping it FAILED: ${r.error}`;
  }
}
