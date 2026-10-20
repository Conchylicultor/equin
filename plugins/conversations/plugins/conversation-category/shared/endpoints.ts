import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// --- Body schemas ---

export const SetCategoryItemBodySchema = z.object({
  categoryId: z.string().min(1),
  item: z.string().min(1),
});
export type SetCategoryItemBody = z.infer<typeof SetCategoryItemBodySchema>;

// An empty/absent `categoryIds` means "every configured category". A non-empty
// list restricts the run to those categories — that is how a single chip's
// "Re-classify" button asks for just its own axis.
export const ClassifyBodySchema = z.object({
  categoryIds: z.array(z.string()).optional(),
});
export type ClassifyBody = z.infer<typeof ClassifyBodySchema>;

// --- Endpoint definitions ---

// Classify and set read the categories config (classify also runs the Haiku
// CLI), so they are desktop-only until config is portable: served by machine/,
// answered "not available" on a host without the computer. Clear is a pure DB
// write and is served everywhere.

export const classifyConversation = defineEndpoint({
  route: "POST /api/conversation-category/:conversationId/classify",
  body: ClassifyBodySchema,
  needsMachine: { feature: "Classifying conversations" },
});

export const setConversationCategory = defineEndpoint({
  route: "POST /api/conversation-category/:conversationId",
  body: SetCategoryItemBodySchema,
  needsMachine: { feature: "Setting a conversation's category" },
});

export const clearConversationCategory = defineEndpoint({
  route: "DELETE /api/conversation-category/:conversationId/:categoryId",
});
