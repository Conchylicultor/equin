import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { conversationContextShape } from "../../core";

// A conversation's last context reading (`conversationContextShape`): one row
// per conversation, written by its runtime as the agent reports a reading.
export const conversationContext = defineExtension(
  _conversations,
  "context_usage",
  conversationContextShape,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _conversationContextTable = conversationContext.table;
