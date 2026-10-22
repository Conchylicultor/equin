import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const generateConversationSummary = defineEndpoint({
  route: "POST /api/conversation-summary/:conversationId/generate",
  response: z.object({
    spawnedConversationId: z.string(),
    turnCount: z.number(),
  }),
  needsMachine: { feature: "Summarising a conversation" },
});
