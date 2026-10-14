import { acquireCheckoutWatch } from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { fileExplorerGitStatus, type GitStatus } from "../../shared/resources";
import { assertCheckoutRoot } from "./checkout";
import { gitStatusMemo } from "./status";

async function loadGitStatus({ root }: { root: string }): Promise<GitStatus> {
  await assertCheckoutRoot(root);
  return gitStatusMemo.get(root);
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
    // `--branch` reads ahead/behind: the own branch and its upstream. The
    // checkout watch already dropped the paths git ignores (a build writing
    // `.cache/`, another worktree under `.claude/`), so every batch can move
    // the status.
    const release = await acquireCheckoutWatch(root, {
      refs: { also: [], upstream: true },
      onChange: () => notify(),
    });
    return () => {
      gitStatusMemo.evict(root);
      release();
    };
  },
});
