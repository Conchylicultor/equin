import { join } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import {
  editedFilesServed,
  getEditedFiles,
} from "@plugins/conversations/plugins/conversation-view/plugins/code/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import type { PluginChangesResponse } from "../../core/protocol";
import { pluginChanges } from "../../shared/resources";
import { computePluginChanges } from "./compute-plugin-diff";
import { getMainPluginsDir } from "./main-plugins-dir";
import { getMainPluginTree, getWorktreePluginTree } from "./plugin-tree-cache";

async function computeWorktreePluginChanges(
  conversationId: string,
): Promise<PluginChangesResponse> {
  const conversation = await getConversation(conversationId);
  if (!conversation?.worktreePath) return { plugins: [] };

  const [editedFiles, mainPluginsDir] = await Promise.all([
    getEditedFiles(conversation.worktreePath),
    getMainPluginsDir(),
  ]);

  const worktreePluginsDir = join(conversation.worktreePath, "plugins");
  // Each side is memoized on its own cheap signature (main → main sha, worktree
  // → edited-files content signature) and owns its withHeavyReadSlot internally, so an
  // unchanged side is a pure hit that takes no slot. Steady-state recomputes
  // rebuild at most one tree.
  const [worktreeTree, mainTree] = await Promise.all([
    getWorktreePluginTree(conversation.worktreePath, worktreePluginsDir),
    getMainPluginTree(mainPluginsDir),
  ]);
  const plugins = computePluginChanges(worktreeTree, mainTree, editedFiles);
  return { plugins };
}

// External: the truth is the worktree's and main's plugin trees on disk plus
// git, which no change feed can see. It recomputes on exactly the two things
// that move the diff:
//
// - **a worktree file edit** — the conversation's own `edited-files` tuple
//   (`{ id }`) maps to this conversation's tuple.
// - **a git ref advance** (local commit / rebase / sync-to-head, or main
//   moving) — the bare `refHeadServed` recomputes every subscribed
//   conversation. git-watcher only tracks `main` + this worktree's own branch,
//   so a notify already implies a relevant ref moved — no need to inspect the
//   refName (same reasoning as commits-graph).
export const pluginChangesServed = serveValue(pluginChanges, {
  source: "external",
  changes: "notified",
  loader: ({ conversationId }) => computeWorktreePluginChanges(conversationId),
  // Coalesce rapid-fire git changes (frequent agent commits): at most one
  // recompute per 3 s window — a trailing window a later change does not
  // re-arm — so a burst costs one heavy buildPluginTree per window, not one per
  // commit.
  throttleMs: 3000,
  recomputeOn: [
    {
      value: editedFilesServed,
      params: ({ id }) => ({ conversationId: id }),
    },
    refHeadServed,
  ],
});
