import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface ConversationFlagRaisedPayload {
  conversationId: string;
  taskId: string;
  reason: string;
  [key: string]: unknown;
}

// Emitted by `flag_raise` in the transaction that records the flag.
// Filterable by taskId.
export const {
  event: conversationFlagRaised,
  table: _conversationFlagRaisedTriggers,
} = defineTriggerEvent<ConversationFlagRaisedPayload>({
  name: "conversation.flagRaised",
  filters: {
    taskId: text("task_id"),
  },
});
