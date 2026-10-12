import { resolve } from "node:path";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import {
  createCheckoutWatchHub,
  type CheckoutChange,
  type CheckoutWatchRelease,
} from "./hub";

export type { CheckoutChange, CheckoutWatchRelease } from "./hub";

/**
 * The git dirs to watch beside `root`. A main checkout keeps its git dir at
 * `root/.git`, inside the working-tree watch; a linked worktree keeps it in the
 * main repo's `.git/worktrees/<name>`, and its refs (shared by every worktree)
 * in the common dir's `refs/`.
 */
async function gitDirsOutside(root: string): Promise<string[]> {
  const out = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    root,
  );
  const [gitDir = "", commonDir = ""] = out.split("\n");
  const inside = (dir: string) => dir === root || dir.startsWith(`${root}/`);
  return [gitDir, resolve(commonDir, "refs")].filter(
    (dir) => dir !== "" && !inside(dir),
  );
}

const hub = createCheckoutWatchHub({ gitDirsOutside, acquireDirWatch });

/**
 * Hear every change that can move the git checkout at `root` (its toplevel):
 * its working tree, and its git dir — HEAD, the index, refs — wherever they
 * live. Each change is tagged `worktree` or `git`. Readers of one checkout
 * share one watch; the last release stops it. Resolves once the watch is
 * live; rejects when `root` is not a checkout that can be watched.
 *
 * ```ts
 * whileSubscribed: async ({ root }, notify) =>
 *   acquireCheckoutWatch(root, () => notify()),
 * ```
 */
export function acquireCheckoutWatch(
  root: string,
  onChange: (changes: CheckoutChange[]) => void,
): Promise<CheckoutWatchRelease> {
  return hub.acquire(root, onChange);
}
