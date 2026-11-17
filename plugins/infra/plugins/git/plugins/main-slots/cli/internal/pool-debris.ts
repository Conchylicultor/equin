import { randomUUID } from "node:crypto";
import { mkdir, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  readdir,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { checkoutAdminDir } from "@plugins/infra/plugins/paths/core";
import { withWorktreeMutateSlot } from "@plugins/infra/plugins/worktree/server";
import { mainSlotsDir } from "../../core";

// The pool's DEBRIS: checkouts that are not slots — a slot being made
// (`.staging/<name>`, published into the pool by a rename once whole) and a
// slot being removed (`.trash-<id>-<ms>`, renamed out of the pool first).
// Dot names, so `listSlots` never lists one. Their slow work — `git worktree
// add`'s writes, a recursive delete, the worktree-mutate gate — runs OUTSIDE
// the pool lock; only the renames that publish or unlist a slot run under it.
//
// Each is CLAIMED while its owner works on it: an exclusive flock on
// `<debris>.lock`, taken before the dir exists. A sweep (`sweepDebris`) takes
// only what nobody claims — what an owner killed mid-way left — so it never
// deletes under a live owner, and the kernel drops a dead owner's claim.

/** Removed slots are renamed here first (same volume: atomic), then deleted. */
const TRASH_PREFIX = ".trash-";
/** Slots being made live here until whole. */
const STAGING_DIR = ".staging";
const CLAIM_SUFFIX = ".lock";

/** How a debris tree is deleted. Default: a recursive `rm`. */
export type RemoveTree = (path: AppPath) => Promise<void>;

export const removeTreeDefault: RemoveTree = async (path) => {
  await rm(path, { recursive: true, force: true });
};

/** A debris path its owner holds; `release` drops the claim (and its file). */
export interface DebrisClaim {
  path: AppPath;
  release: () => Promise<void>;
}

/** Claim `path` (its `.lock` flock), or `null` when someone holds it. */
async function claim(path: AppPath): Promise<DebrisClaim | null> {
  const lockPath = asAppPath(`${path}${CLAIM_SUFFIX}`);
  const fd = await openOwnedFd(lockPath, "a");
  if (!flockTry(fd.fd)) {
    fd.close();
    return null;
  }
  return {
    path,
    release: async () => {
      // Unlinked before the close drops the flock: an opener of the old
      // file in between finds it held and leaves it.
      await unlink(lockPath).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      fd.close();
    },
  };
}

async function claimFresh(path: AppPath): Promise<DebrisClaim> {
  const got = await claim(path);
  if (got === null)
    throw new Error(`main-slots: ${path} is fresh, yet already claimed`);
  return got;
}

/** A new trash path for slot `id`, claimed — the dir does not exist yet. */
export async function claimTrash(id: string): Promise<DebrisClaim> {
  return claimFresh(
    joinAppPath(mainSlotsDir(), `${TRASH_PREFIX}${id}-${Date.now()}`),
  );
}

/** A new staging path for a slot being made, claimed — the dir does not exist yet. */
export async function claimStaging(): Promise<DebrisClaim> {
  const dir = joinAppPath(mainSlotsDir(), STAGING_DIR);
  await mkdir(dir, { recursive: true });
  return claimFresh(joinAppPath(dir, `slot-${randomUUID().slice(0, 8)}`));
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The registration (`<common git dir>/worktrees/<id>/`) a debris checkout's
 * `.git` names, when no OTHER checkout claims it — `null` when there is none
 * (a half-made checkout with no `.git` yet, an entry already deleted), or
 * when its `gitdir` points at a live checkout that names it back (never
 * deleted). A trash's entry points at the slot path it was renamed from; a
 * staging dir's at itself, or at the slot it was about to be published as.
 */
async function orphanedEntryOf(debris: AppPath): Promise<string | null> {
  const admin = await checkoutAdminDir(debris);
  if (admin === null) return null;
  const entry = dirname(admin);
  if (!dirname(entry).endsWith("/worktrees")) {
    throw new Error(
      `main-slots: ${debris}'s git dir ${entry} is not a linked worktree's entry — refusing to delete it`,
    );
  }
  let back: string;
  try {
    back = resolve(
      entry,
      (await readFile(join(entry, "gitdir"), "utf8")).trim(),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No entry left (deleted already), or one with no backlink: ours.
    return (await realpathOrNull(entry)) === null ? null : entry;
  }
  const claimant = asAppPath(dirname(back));
  const claimantReal = await realpathOrNull(claimant);
  if (
    claimantReal !== null &&
    claimantReal !== (await realpathOrNull(debris))
  ) {
    const claimantAdmin = await checkoutAdminDir(claimant);
    if (
      claimantAdmin !== null &&
      (await realpathOrNull(dirname(claimantAdmin))) ===
        (await realpathOrNull(entry))
    ) {
      return null;
    }
  }
  return entry;
}

/**
 * Delete a debris checkout the caller claims: its registration first (only
 * its own — never a repo-wide `git worktree prune`), under the host-wide
 * worktree-mutate gate, then its tree. Never under the pool lock: the gate
 * waits on other checkouts' adds, and a slot's tree is ~GBs.
 */
export async function discardDebris(
  path: AppPath,
  removeTree: RemoveTree = removeTreeDefault,
): Promise<void> {
  const entry = await orphanedEntryOf(path);
  if (entry !== null) {
    await withWorktreeMutateSlot(async () => {
      await rm(entry, { recursive: true, force: true });
    });
  }
  await removeTree(path);
}

/**
 * Delete what an owner killed mid-way left: every unclaimed trash and staging
 * dir (and claim file without a dir). Outside the pool lock — a live owner's
 * claim keeps its own debris out of the sweep.
 */
export async function sweepDebris(
  removeTree: RemoveTree = removeTreeDefault,
): Promise<void> {
  const pool = mainSlotsDir();
  const paths: AppPath[] = [];
  for (const name of await namesIn(pool)) {
    if (name.startsWith(TRASH_PREFIX)) paths.push(joinAppPath(pool, name));
  }
  const staging = joinAppPath(pool, STAGING_DIR);
  for (const name of await namesIn(staging))
    paths.push(joinAppPath(staging, name));

  const debris = new Set<AppPath>();
  for (const p of paths) {
    debris.add(
      p.endsWith(CLAIM_SUFFIX)
        ? asAppPath(p.slice(0, -CLAIM_SUFFIX.length))
        : p,
    );
  }
  for (const path of debris) {
    const claimed = await claim(path);
    if (claimed === null) continue;
    try {
      if ((await realpathOrNull(path)) !== null)
        await discardDebris(path, removeTree);
    } finally {
      await claimed.release();
    }
  }
}

async function namesIn(dir: AppPath): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
