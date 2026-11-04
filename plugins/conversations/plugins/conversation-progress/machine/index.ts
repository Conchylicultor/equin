import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { CloseTeardown } from "@plugins/conversations/plugins/close/server";
import { classifyProgressJob } from "./internal/heuristic-job";
import { unfollowConversation } from "./internal/progress-watch";

export default {
  description:
    "Conversation progress, desktop-only half: classifies a conversation as researching, designing or implementing from the files its worktree changed against main (no files = research, only research/** = design, any other file = implementation). Its first turn starts a checkout watch on the worktree and classifies the whole tree once; from then on each change is checked against git for its own paths only, until implementation is reached or the conversation closes.",
  contributions: [
    Trigger({
      on: conversationTurnCompleted,
      do: classifyProgressJob,
      with: {},
      oneShot: false,
    }),
    CloseTeardown({
      id: "conversation-progress.unfollow",
      stop: (conversationId) => {
        unfollowConversation(conversationId);
        return Promise.resolve();
      },
    }),
  ],
  register: [classifyProgressJob],
} satisfies MachinePluginDefinition;
