import { defineHintAnchor } from "@plugins/hints/core";

/** One conversation's row in the agent manager's conversation list, by conversation id. */
export const conversationRowAnchor = defineHintAnchor(
  "conversations.row",
  (convId: string) => convId,
);
