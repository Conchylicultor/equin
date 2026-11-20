import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/** The longest title a person may give a conversation. */
export const CONVERSATION_TITLE_MAX = 200;

/**
 * Name a conversation by hand. The title is trimmed and must not be empty
 * (400). It sticks: the task's generated title only replaces a conversation
 * title that is missing or still the placeholder the task was filed with.
 */
export const renameConversation = defineEndpoint({
  route: "PUT /api/conversations/:id/title",
  body: z.object({
    title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX),
  }),
});
