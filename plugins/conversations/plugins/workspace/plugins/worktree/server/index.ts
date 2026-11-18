import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import {
  fsmonitorOnConversationEndedJob,
  fsmonitorReconcileJob,
  fsmonitorReconcileWarmup,
} from "./internal/fsmonitor-job";
import { worktreePrepareJob } from "./internal/prepare-job";
import { checkoutProgress } from "./internal/tables-checkout-progress";
import { worktreeWorkspace } from "./internal/worktree-workspace";

export default {
  description:
    "The worktree workspace: a conversation runs in its attempt's git checkout of this repo (`.claude/worktrees/<id>`), with a forked DB and config dir — checked out by the supervised worktree.prepare job (a detached child a restart does not kill) that the spawn job requests and waits on, resumable while the checkout exists. Keeps git's fsmonitor daemon running for exactly the checkouts whose attempt is still retained (worktree.fsmonitor-reconcile, main only: on a conversation closing, at start and every 10 minutes).",
  contributions: [
    Trigger({
      on: conversationStatusChanged,
      do: fsmonitorOnConversationEndedJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [
    Workspace.define(worktreeWorkspace),
    checkoutProgress,
    worktreePrepareJob,
    fsmonitorReconcileJob,
    fsmonitorOnConversationEndedJob,
    fsmonitorReconcileWarmup,
  ],
} satisfies ServerPluginDefinition;
