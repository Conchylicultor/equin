import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { worktreeWorkspace } from "./internal/worktree-workspace";

export default {
  description:
    "The worktree workspace: a conversation runs in its attempt's git checkout of this repo (`.claude/worktrees/<id>`), with a forked DB and config dir — checked out in the spawn job, resumable while the checkout exists.",
  register: [Workspace.define(worktreeWorkspace)],
} satisfies ServerPluginDefinition;
