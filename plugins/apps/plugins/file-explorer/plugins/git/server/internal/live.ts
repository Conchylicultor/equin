import { acquireCheckoutWatch } from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { fileExplorerGitStatus, type GitStatus } from "../../shared/resources";
import {
  indexGitStatus,
  relativeTo,
  type GitStatusIndex,
} from "../../shared/status-index";
import { assertCheckoutRoot } from "./checkout";
import { gitStatusMemo } from "./status";

/**
 * The last status served per root, indexed — so a change inside a folder git
 * ignores (a build writing `.cache/`, another worktree under `.claude/`) is
 * dropped before it costs a recompute.
 */
const lastIndex = new Map<string, GitStatusIndex>();

/**
 * Whether a working-tree change can move the status: one in a path git ignores
 * cannot (its own appearance aside, which a later change reconciles). A git-dir
 * change always can.
 */
function matters(root: string, path: string): boolean {
  const rel = relativeTo(root, path);
  if (rel === null) return true;
  return !(lastIndex.get(root)?.isIgnored(rel) ?? false);
}

async function loadGitStatus({ root }: { root: string }): Promise<GitStatus> {
  await assertCheckoutRoot(root);
  const status = await gitStatusMemo.get(root);
  lastIndex.set(root, indexGitStatus(status));
  return status;
}

/**
 * A checkout's git status, pushed. The truth is the working tree and the git
 * dir, written by any process (an editor, an agent, `git commit`), so the push
 * comes from the checkout watch (working tree + git dir, shared with every
 * other reader of the checkout) for as long as anyone is subscribed — never a
 * poll. External, and bounded by what changed in the checkout.
 */
export const gitStatusServed = serveValue(fileExplorerGitStatus, {
  source: "external",
  changes: "notified",
  loader: loadGitStatus,
  revalidate: async ({ root }) => {
    await assertCheckoutRoot(root);
    return gitStatusMemo.signature(root);
  },
  whileSubscribed: async ({ root }, notify) => {
    await assertCheckoutRoot(root);
    const release = await acquireCheckoutWatch(root, (changes) => {
      if (changes.some((c) => c.area === "git" || matters(root, c.path))) {
        notify();
      }
    });
    return () => {
      lastIndex.delete(root);
      gitStatusMemo.evict(root);
      release();
    };
  },
});
