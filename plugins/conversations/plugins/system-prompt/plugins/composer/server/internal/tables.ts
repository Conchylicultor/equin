import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { conversationSystemPromptShape } from "@plugins/conversations/plugins/system-prompt/core";

// What equin appended to a conversation's system prompt at its last spawn
// (`conversationSystemPromptShape`): one row per conversation, rewritten by
// the composer at each spawn.
export const conversationSystemPromptExt = defineExtension(
  _conversations,
  "system_prompt",
  conversationSystemPromptShape,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _conversationSystemPromptTable = conversationSystemPromptExt.table;
