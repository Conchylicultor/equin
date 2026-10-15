import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface UserTurnSentPayload {
  conversationId: string;
  taskId: string;
  text: string;
  [key: string]: unknown;
}

export const { event: userTurnSent, table: _userTurnSentTriggers } =
  defineTriggerEvent<UserTurnSentPayload>({
    name: "conversation.userTurnSent",
    filters: {
      conversationId: text("conversation_id"),
    },
  });
