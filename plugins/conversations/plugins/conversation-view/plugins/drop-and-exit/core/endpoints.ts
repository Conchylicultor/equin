import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Close a conversation and drop its task. Predicted for the conversation
 * half only (as `exitConversation`): whether the task was dropped (`dropped`)
 * is the server's decision, read from the response and the task's push.
 */
export const dropAndExit = defineEndpoint({
  route: "POST /api/conversations/:id/drop-and-exit",
  response: z.object({ ok: z.boolean(), dropped: z.boolean() }),
  needsMachine: { feature: "Closing an agent's conversation" },
});
