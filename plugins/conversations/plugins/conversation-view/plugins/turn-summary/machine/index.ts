import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { generateTurnSummaryJob } from "./internal/job";

export default {
  description:
    "Turn summaries, desktop-only half: after every assistant turn, runs Haiku (the Claude CLI) on the (user, assistant) pair to write the one-line summary, caveats and actions, gated by the turn-summary config the portable half registers.",
  contributions: [
    Trigger({
      on: conversationTurnCompleted,
      do: generateTurnSummaryJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [generateTurnSummaryJob],
} satisfies MachinePluginDefinition;
