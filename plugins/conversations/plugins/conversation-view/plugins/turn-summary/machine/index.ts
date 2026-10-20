import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { turnSummaryConfig } from "../shared/config";
import { generateTurnSummaryJob } from "./internal/job";

export default {
  description:
    "Turn summaries, desktop-only half: after every assistant turn, runs Haiku (the Claude CLI) on the (user, assistant) pair to write the one-line summary, caveats and actions, gated by the turn-summary config it registers.",
  contributions: [
    ConfigV2.Register({ descriptor: turnSummaryConfig }),
    Trigger({
      on: conversationTurnCompleted,
      do: generateTurnSummaryJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [generateTurnSummaryJob],
} satisfies MachinePluginDefinition;
