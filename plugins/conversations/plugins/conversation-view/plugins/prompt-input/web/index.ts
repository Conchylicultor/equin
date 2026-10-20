import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { PromptInput } from "./components/prompt-input";

export { setConversationPromptDraft } from "./internal/draft";

export default {
  description:
    "Free-form text input at the bottom of the conversation view. Enter sends a turn; fork buttons reuse the draft as the new conversation's initial prompt.",
  contributions: [
    Conversation.PromptInput({
      id: "prompt-input",
      requires: [],
      component: PromptInput,
    }),
  ],
} satisfies PluginDefinition;
