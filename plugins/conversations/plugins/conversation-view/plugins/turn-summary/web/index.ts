import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { turnSummaryConfig } from "../shared/config";
import { TurnSummaryCard } from "./components/turn-summary-card";
import { turnSummariesDemo } from "./internal/demo-resource";

export default {
  description:
    "Inline card above the prompt input showing a Haiku-generated summary of the latest assistant turn, with caveats and suggested actions.",
  contributions: [
    turnSummariesDemo,
    Conversation.AbovePromptInput({
      id: "turn-summary",
      requires: [],
      component: TurnSummaryCard,
    }),
    ConfigV2.WebRegister({ descriptor: turnSummaryConfig }),
  ],
} satisfies PluginDefinition;
