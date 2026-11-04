import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

// Fires when the JSONL watcher detects a new assistant turn that ended with
// `stop_reason === "end_turn"` AND whose Stop hooks then let the agent stop
// (`stopHooks: "allowed"`) — i.e. Claude finished speaking, is not waiting on
// a tool result, no hook sent it back to work, and no hook is still running. Durable jobs use this to suspend on "wait for
// Claude to finish talking" without polling (see push-and-exit).
export interface ConversationTurnCompletedPayload {
  conversationId: string;
  stopReason: "end_turn";
  text: string;
  messageId: string | null;
  [key: string]: unknown;
}

export const {
  event: conversationTurnCompleted,
  table: _conversationTurnCompletedTriggers,
} = defineTriggerEvent<ConversationTurnCompletedPayload>({
  name: "conversation.turn-completed",
  filters: {
    conversationId: text("conversation_id"),
  },
});
