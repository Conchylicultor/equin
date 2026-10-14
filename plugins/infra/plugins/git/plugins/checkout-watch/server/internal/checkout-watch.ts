import { resolve } from "node:path";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import {
  runGit,
  tryRunGit,
  WorktreeGoneError,
} from "@plugins/primitives/plugins/commit-list/server";
import {
  createCheckoutWatchHub,
  type CheckoutBranch,
  type CheckoutLocation,
  type CheckoutWatchRelease,
  type CheckoutWatchRequest,
} from "./hub";
import { ignoredPaths } from "./ignored-paths";

export type {
  CheckoutChange,
  CheckoutRefs,
  CheckoutWatchRelease,
  CheckoutWatchRequest,
} from "./hub";

/**
 * A main checkout keeps its git dir at `root/.git`, inside the working-tree
 * watch; a linked worktree keeps it in the main repo's `.git/worktrees/<name>`,
 * and its refs (shared by every worktree) in the common dir's `refs/`.
 */
async function locate(root: string): Promise<CheckoutLocation> {
  const out = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    root,
  );
  const [gitDir = "", commonDir = ""] = out.split("\n");
  if (gitDir === "" || commonDir === "") {
    throw new Error(`[checkout-watch] no git dir for ${root}: ${out}`);
  }
  return { gitDir, commonDir: resolve(commonDir) };
}

/**
 * HEAD's target (null when detached) and its upstream (null when it has
 * none). A checkout reaped while watched is on no branch: its readers hear
 * the removal itself.
 */
async function readBranch(root: string): Promise<CheckoutBranch> {
  try {
    const head = await tryRunGit(["symbolic-ref", "-q", "HEAD"], root);
    if (!head.ok) return { own: null, upstream: null };
    const own = head.stdout.trim();
    const upstream = (
      await runGit(["for-each-ref", "--format=%(upstream)", own], root)
    ).trim();
    return { own, upstream: upstream === "" ? null : upstream };
  } catch (err) {
    if (err instanceof WorktreeGoneError) return { own: null, upstream: null };
    throw err;
  }
}

const hub = createCheckoutWatchHub({
  locate,
  readBranch,
  ignored: ignoredPaths,
  acquireDirWatch,
});

/**
 * Hear every change that can move the git checkout at `root` (its toplevel):
 * its working tree, and its git dir — HEAD, the index, and the refs `refs`
 * names (its own branch always) — wherever they live; working-tree paths git
 * ignores are dropped. Each change is tagged `worktree` or `git`. Readers of one checkout share one watch; the last
 * release stops it. Return the reaction's promise from `onChange`: one runs at
 * a time per reader, and batches landing meanwhile fold into one trailing
 * call. Resolves once the watch is live; rejects when `root` is not a
 * checkout that can be watched.
 *
 * ```ts
 * whileSubscribed: async ({ root }, notify) =>
 *   acquireCheckoutWatch(root, { refs: { also: [] }, onChange: () => notify() }),
 * ```
 */
export function acquireCheckoutWatch(
  root: string,
  request: CheckoutWatchRequest,
): Promise<CheckoutWatchRelease> {
  return hub.acquire(root, request);
}
