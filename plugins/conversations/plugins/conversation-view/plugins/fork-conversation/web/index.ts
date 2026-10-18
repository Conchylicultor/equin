import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { ForkConversationButtons } from "./components/fork-conversation-buttons";

export default {
  description:
    "Side chat: an icon split under the prompt that opens a new, blank conversation in the same worktree — the icon on the default model, the chevron to pick another.",
  contributions: [
    Conversation.PromptBar({
      id: "fork-conversation",
      requires: [],
      component: ForkConversationButtons,
      section: "New",
      sectionOrder: 1,
    }),
  ],
} satisfies PluginDefinition;
