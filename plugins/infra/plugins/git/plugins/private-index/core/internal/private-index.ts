import {
  constants,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { copyFile, open, rename, unlink, utimes } from "node:fs/promises";
import { openOwnedFdSync } from "@plugins/packages/plugins/owned-fd/core";
import { stat, statSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  type AppPath,
  appPathParent,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * The real index as it was stat'ed when it was copied: what the copy's mtime
 * is stamped from, and what the swap compares against. A bigint `Stats`.
 */
export interface SeenIndex {
  ino: bigint;
  size: bigint;
  atimeMs: bigint;
  mtimeMs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/**
 * What a publish did: the refreshed copy replaced the real index, or it did
 * not because a git writer held `index.lock` (`index-busy`), or because the
 * real index was written since it was copied (`index-changed`). Never an
 * error: a publish is an optimisation, and the refreshed copy is discarded.
 */
export type IndexPublish = "published" | "index-busy" | "index-changed";

/**
 * The copy's timestamps: the SOURCE's, never now. Load-bearing for
 * correctness, not tidiness: git re-checks by content every entry whose file
 * is not strictly older (in whole seconds — Apple git has no USE_NSEC) than
 * the index file, which is how a file edited in the same second as the index
 * was written is still caught. A fresh mtime would make those entries trusted
 * by stat — a stale tree hashed, a modified file reported clean.
 */
function stampOf(seen: SeenIndex): [atime: number, mtime: number] {
  return [Number(seen.atimeMs) / 1000, Number(seen.mtimeMs) / 1000];
}

/** git's own lock for `index`: `<index>.lock`, beside it. */
function lockOf(index: AppPath): AppPath {
  const name = index.slice(index.lastIndexOf("/") + 1);
  return joinAppPath(appPathParent(index), `${name}.lock`);
}

/** Whether the real index is still the one `seen` stat'ed. */
function unchangedSince(now: SeenIndex, seen: SeenIndex): boolean {
  return (
    now.ino === seen.ino &&
    now.size === seen.size &&
    now.mtimeNs === seen.mtimeNs &&
    now.ctimeNs === seen.ctimeNs
  );
}

/** A `wx` open that lost to an existing lock: a git writer holds it. */
function isHeld(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Write an index's `bytes` to `dst` (which must not exist) stamped with the
 * source's timestamps (`stampOf`). Sync: for the CLI's own thread.
 */
export function writeIndexCopySync(
  bytes: Uint8Array,
  seen: SeenIndex,
  dst: AppPath,
): void {
  writeFileSync(dst, bytes, { flag: "wx" });
  utimesSync(dst, ...stampOf(seen));
}

/**
 * Copy the index at `src` to `dst` (which must not exist) stamped with the
 * source's timestamps as `seen` read them — `writeIndexCopySync`'s async twin.
 */
export async function copyIndex(
  src: AppPath,
  seen: SeenIndex,
  dst: AppPath,
): Promise<void> {
  await copyFile(src, dst, constants.COPYFILE_EXCL);
  await utimes(dst, ...stampOf(seen));
}

/**
 * Replace `realIndex` with `refreshed`, compare-and-swap: only while nobody
 * has written it since it was copied (`seen`), and only under git's own
 * `index.lock`, taken `wx` the way every git writer takes it — if one holds
 * it, this does not publish.
 *
 * Why publish at all: every child we spawn runs with `GIT_OPTIONAL_LOCKS=0`
 * (spawn's child-env), so no git READ ever saves the stat cache it refreshes
 * or the untracked cache it fills. Whatever left the real index unable to
 * vouch for its files — a whole-tree checkout (11,200 of 20,664 entries racily
 * clean after a 2 s `worktree add`), a spare claim's `switch`, a rebase, a
 * codegen rewrite — stays that way until the next commit, and every status
 * re-reads those files and every directory.
 *
 * Why this cannot reintroduce the collision spawn's child-env exists for (a
 * push's `merge` in main failing on "index.lock: File exists" beside a
 * `git status`): the lock is held for one stat and one rename — not for the
 * seconds a refresh takes, which ran on the private copy. The refreshed copy
 * differs from the real index in stat data and the untracked cache only
 * (status never stages), and git wrote it with a fresh mtime, so racy-git
 * protection holds for it as for any index git writes.
 *
 * Sync — no await between taking the lock and releasing it, so no other work
 * of the thread stretches the window. For the CLI's own thread.
 */
export function publishRefreshedIndexSync(
  realIndex: AppPath,
  refreshed: AppPath,
  seen: SeenIndex,
): IndexPublish {
  const lock = lockOf(realIndex);
  let held;
  try {
    held = openOwnedFdSync(lock, "wx");
  } catch (err) {
    if (isHeld(err)) return "index-busy";
    throw err;
  }
  try {
    if (!unchangedSince(statSync(realIndex, { bigint: true }), seen))
      return "index-changed";
    renameSync(refreshed, realIndex);
    return "published";
  } finally {
    held.close();
    unlinkSync(lock);
  }
}

/** `publishRefreshedIndexSync`'s async twin, for a backend's thread. */
export async function publishRefreshedIndex(
  realIndex: AppPath,
  refreshed: AppPath,
  seen: SeenIndex,
): Promise<IndexPublish> {
  const lock = lockOf(realIndex);
  let held;
  try {
    held = await open(lock, "wx");
  } catch (err) {
    if (isHeld(err)) return "index-busy";
    throw err;
  }
  try {
    if (!unchangedSince(await stat(realIndex, { bigint: true }), seen))
      return "index-changed";
    await rename(refreshed, realIndex);
    return "published";
  } finally {
    await held.close();
    await unlink(lock);
  }
}
