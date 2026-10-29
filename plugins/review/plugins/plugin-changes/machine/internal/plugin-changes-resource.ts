import { join } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import {
  getEditedFiles,
  watchEditedFiles,
} from "@plugins/conversations/plugins/conversation-view/plugins/code/server";
import { conversationWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationWorkspaceOf } from "@plugins/tasks/plugins/tasks-core/core";
import type { PluginChangesResponse } from "../../core/protocol";
import { pluginChanges } from "../../shared/resources";
import { computePluginChanges } from "../../server/internal/compute-plugin-diff";
import { getMainPluginsDir } from "../../server/internal/main-plugins-dir";
import {
  getMainPluginTree,
  getWorktreePluginTree,
} from "../../server/internal/plugin-tree-cache";

// The conversation's worktree, from its followed workspace row (`followed.ws`,
// below) — null for a conversation with no row or no path yet.
function worktreePathOf(
  ws: readonly { readonly worktreePath: string }[],
): string | null {
  return conversationWorkspaceOf(ws)?.worktreePath ?? null;
}

async function computeWorktreePluginChanges(
  worktreePath: string | null,
): Promise<PluginChangesResponse> {
  if (worktreePath === null) return { plugins: [] };

  const [worktreeFiles, mainPluginsDir] = await Promise.all([
    getEditedFiles(worktreePath),
    getMainPluginsDir(),
  ]);

  const worktreePluginsDir = join(worktreePath, "plugins");
  // Each side is memoized on its own cheap signature (main → main sha, worktree
  // → edited-files content signature) and owns its withHeavyReadSlot internally, so an
  // unchanged side is a pure hit that takes no slot. Steady-state recomputes
  // rebuild at most one tree.
  const [worktreeTree, mainTree] = await Promise.all([
    getWorktreePluginTree(worktreePath, worktreePluginsDir),
    getMainPluginTree(mainPluginsDir),
  ]);
  const plugins = computePluginChanges(worktreeTree, mainTree, worktreeFiles);
  return { plugins };
}

// External: the truth is the worktree's and main's plugin trees on disk plus
// git, which no change feed can see. It recomputes on exactly the three things
// that move the diff:
//
// - **a worktree file edit** — the conversation's worktree watch, the same
//   refcounted room `edited-files` reads through (`watchEditedFiles`), held
//   while the tuple is subscribed: it notifies when the edited list changes.
//   Not a `recomputeOn` edge onto `edited-files`: that value is key-range
//   paged, and a keyed window cascades nothing (D32).
// - **a git ref advance** (local commit / rebase / sync-to-head, or main
//   moving) — the bare `refHeadServed` recomputes every subscribed
//   conversation. git-watcher only tracks `main` + this worktree's own branch,
//   so a notify already implies a relevant ref moved — no need to inspect the
//   refName (same reasoning as commits-graph).
// - **a move of its worktree** — the followed workspace row (below).
export const pluginChangesServed = serveValue(pluginChanges, {
  source: "external",
  changes: "notified",
  // The conversation's workspace row — tasks-core's `conversationWorkspaces`,
  // `{ ids: [id] }` — the one Postgres read the loader and the watch make:
  // a write that moves it (the conversation's `attempt_id`, its attempt's
  // `worktree_path`) re-runs that conversation's tuple, and no other. Its own
  // follow, not only the edited-files watch: that reaches only an edit, so a
  // tuple subscribed here with edited-files unsubscribed would miss a write
  // that moves its worktree.
  follows: (follow) => ({
    ws: follow(conversationWorkspacesServed, ({ conversationId }) => ({
      ids: [conversationId],
    })),
  }),
  loader: (_p, { followed }) =>
    computeWorktreePluginChanges(worktreePathOf(followed.ws)),
  // Coalesce rapid-fire git changes (frequent agent commits): at most one
  // recompute per 3 s window — a trailing window a later change does not
  // re-arm — so a burst costs one heavy buildPluginTree per window, not one per
  // commit.
  throttleMs: 3000,
  recomputeOn: [refHeadServed],
  // The worktree's edited-files watch, over the directory the followed row
  // names. No worktree: the loader answers no plugins, and there is nothing
  // to watch — the framework re-starts the watch over the new path when a
  // write moves it (the follow's re-point), so a worktree checked out after
  // the first subscribe is watched. Once open it notifies: a change between
  // the load and the watch going live is not lost.
  whileFollowing: {
    over: (followed) => worktreePathOf(followed.ws),
    start: async (_p, { over: worktreePath, notify }) => {
      if (worktreePath === null) return () => {};
      const stop = await watchEditedFiles(worktreePath, notify);
      notify();
      return stop;
    },
  },
});
