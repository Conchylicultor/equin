import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const generateConversationSummary = defineEndpoint({
  route: "POST /api/conversation-summary/:conversationId/generate",
  response: z.object({
    spawnedConversationId: z.string(),
    turnCount: z.number(),
  }),
  needsMachine: { feature: "Summarising a conversation" },
  unpredicted: {
    reason: "server-decided",
    why: "It spawns a system conversation that runs an LLM, and the returned spawned conversation id and turn count are what the pane uses.",
  },
});
