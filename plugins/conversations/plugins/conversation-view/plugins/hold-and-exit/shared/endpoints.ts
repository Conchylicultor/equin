import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Hold the conversation's task and close the conversation. Predicted for the
 * conversation half only (as `exitConversation`): the task is found from the
 * conversation server-side, and its hold stamp and derived status arrive by
 * push.
 */
export const holdAndExit = defineEndpoint({
  route: "POST /api/conversations/:id/hold-and-exit",
  needsMachine: { feature: "Closing an agent's conversation" },
});
