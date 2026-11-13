import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import type { FlagItem } from "../../core";

export interface ConversationFlagRaisedPayload {
  conversationId: string;
  taskId: string;
  /** What the user must act on (`Flag.items`). */
  items: FlagItem[];
  /** Notes belonging to no one item, when the agent gave any. */
  details: string | null;
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
