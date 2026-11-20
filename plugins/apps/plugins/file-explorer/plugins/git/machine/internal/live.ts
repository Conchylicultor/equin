import { acquireCheckoutWatch } from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  fileExplorerGitIgnored,
  fileExplorerGitStatus,
  type GitStatus,
} from "../../shared/resources";
import { assertCheckoutRoot } from "./checkout";
import {
  folderIn,
  movesIgnoreRules,
  readIgnoredEntries,
  withinTwoLevels,
} from "./ignored";
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

/**
 * What git ignores in one folder the browser lists, pushed. Its truth is the
 * entries of the folder and of its subfolders, and the checkout's ignore
 * rules, so the push comes from a watch of the folder's tree (riding the
 * checkout watch's tree watch, opened first) filtered to those two levels, and
 * the checkout watch's `.gitignore` / git-dir changes — never a poll, and
 * never a recompute for a change deeper in the tree.
 */
export const gitIgnoredServed = serveValue(fileExplorerGitIgnored, {
  source: "external",
  changes: "notified",
  loader: async ({ root, dir }) => {
    await assertCheckoutRoot(root);
    return readIgnoredEntries(root, dir);
  },
  whileSubscribed: async ({ root, dir }, notify) => {
    await assertCheckoutRoot(root);
    const abs = folderIn(root, dir);
    const releaseRules = await acquireCheckoutWatch(root, {
      refs: { also: [] },
      onChange: (changes) => {
        if (changes.some(movesIgnoreRules)) notify();
      },
    });
    try {
      // The checkout watch keeps the checkout's tree watch open, so this one
      // rides it: no second native watch. Raw changes, ignored paths
      // included — they are what this value is about.
      const releaseTree = await acquireDirWatch({
        dir: abs,
        scope: "subtree",
        onChange: (events) => {
          if (events.some((e) => withinTwoLevels(abs, e.path))) notify();
        },
      });
      return () => {
        releaseTree();
        releaseRules();
      };
    } catch (err) {
      releaseRules();
      throw err;
    }
  },
});
