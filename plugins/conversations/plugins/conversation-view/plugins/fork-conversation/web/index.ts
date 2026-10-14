import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { ForkConversationButtons } from "./components/fork-conversation-buttons";

export default {
  description:
    "Toolbar buttons (+Sonnet / +Opus) that spin up a new conversation in the same worktree.",
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
