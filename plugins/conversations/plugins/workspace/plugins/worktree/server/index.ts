import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { worktreePrepareJob } from "./internal/prepare-job";
import { worktreeWorkspace } from "./internal/worktree-workspace";

export default {
  description:
    "The worktree workspace: a conversation runs in its attempt's git checkout of this repo (`.claude/worktrees/<id>`), with a forked DB and config dir — checked out by the supervised worktree.prepare job (a detached child a restart does not kill) that the spawn job requests and waits on, resumable while the checkout exists.",
  register: [Workspace.define(worktreeWorkspace), worktreePrepareJob],
} satisfies ServerPluginDefinition;
