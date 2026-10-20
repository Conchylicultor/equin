import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { classifyProgressJob } from "./internal/heuristic-job";

export default {
  description:
    "Conversation progress, desktop-only half: after every turn, classifies the conversation as researching, designing or implementing from the files its worktree changed against main (git: no files = research, only research/** = design, any other file = implementation).",
  contributions: [
    Trigger({
      on: conversationTurnCompleted,
      do: classifyProgressJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [classifyProgressJob],
} satisfies MachinePluginDefinition;
