import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import {
  existsSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  flockTryShared,
  waitForFlock,
  type HeldFlock,
} from "@plugins/packages/plugins/flock/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/** The lock file's name inside the checkout's own git dir. */
const TREE_LOCK_FILE = "tree.lock";

/**
 * Where `root`'s tree lock lives: `<git dir>/<lock dir>/tree.lock`, in the
 * checkout's OWN git dir (`<root>/.git` for the main checkout,
 * `<common>/worktrees/<name>` for a linked one) — a tree is per checkout, so
 * two checkouts of one repository never share it. Inside the git dir so git
 * never lists it and no checkout of the code carries it.
 *
 * `null` when `root` is not a git checkout (a compiled release, a temp copy):
 * nothing fast-forwards such a tree, so there is nothing to coordinate.
 */
export function treeLockPath(root: AppPath): AppPath | null {
  const dotGit = joinAppPath(root, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory())
    return joinAppPath(dotGit, LEGACY_IDS.gitLockDir, TREE_LOCK_FILE);
  // A linked worktree's `.git` is a file: `gitdir: <path>`.
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
  if (match === null) {
    throw new Error(
      `tree-lock: ${dotGit} is a file but names no "gitdir:" — not a git checkout git can read either`,
    );
  }
  const gitDir = match[1]!.startsWith("/") ? match[1]! : `${root}/${match[1]!}`;
  return joinAppPath(asAppPath(gitDir), LEGACY_IDS.gitLockDir, TREE_LOCK_FILE);
}

function ensureLockFile(path: AppPath): void {
  mkdirSync(dirname(path), { recursive: true });
}

const NOT_A_CHECKOUT: HeldFlock = {
  releaseSync: () => {},
  release: async () => {},
};

/**
 * Hold `root`'s tree for READING — while this process loads code from it. Any
 * number of readers share it; a writer (`withTreeWrite`) waits for every one of
 * them to release, and a reader arriving while a writer holds it waits for the
 * writer to finish. So a reader sees the tree wholly before or wholly after a
 * fast-forward, never a mix of the two.
 *
 * Fast path in-process (one open + a non-blocking `flock(LOCK_SH)`); only when a
 * writer holds the tree does it wait, in a `flock-wait` child. Release it as
 * soon as the code is loaded: a writer waits for as long as it is held.
 */
export async function holdTreeRead(root: AppPath): Promise<HeldFlock> {
  const path = treeLockPath(root);
  if (path === null) return NOT_A_CHECKOUT;
  ensureLockFile(path);
  const fd = openOwnedFd(path, "a");
  if (flockTryShared(fd.fd)) {
    const releaseSync = (): void => {
      if (!fd.closed) fd.close(); // closing the description drops the lock
    };
    return { releaseSync, release: async () => releaseSync() };
  }
  fd.close();
  return waitForFlock(path, { shared: true });
}

/** How long a writer waits for the tree's readers before failing loudly. */
const WRITE_WAIT_MS = 120_000;

/**
 * Run `write` — a git command that rewrites `root`'s working tree (a
 * fast-forward) — holding the tree exclusively: it starts once no reader is
 * loading code from the tree, and no reader starts until it is done.
 *
 * Readers hold the tree only while they load modules (seconds), so the wait is
 * short. One that outlasts `WRITE_WAIT_MS` means a reader is wedged mid-load —
 * a defect to look at, not to write through — so the write fails loudly,
 * having changed nothing.
 */
export async function withTreeWrite<T>(
  root: AppPath,
  write: () => Promise<T>,
): Promise<T> {
  const path = treeLockPath(root);
  if (path === null) return write();
  ensureLockFile(path);
  const signal = AbortSignal.timeout(WRITE_WAIT_MS);
  let held: HeldFlock;
  try {
    held = await waitForFlock(path, { signal });
  } catch (err) {
    if (signal.aborted) {
      throw new Error(
        `tree-lock: waited ${WRITE_WAIT_MS / 1000} s for ${root}'s tree and a reader still holds it ` +
          `(a process loading code from this checkout, wedged mid-boot). Nothing was written. ` +
          `Find it: lsof ${path}`,
        { cause: err },
      );
    }
    throw err;
  }
  try {
    return await write();
  } finally {
    await held.release();
  }
}
