import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const UpsertNoteBodySchema = z.object({
  notes: z.string().min(1),
});

export const upsertNote = defineEndpoint({
  route: "PUT /api/conversation-notes/:conversationId",
  body: UpsertNoteBodySchema,
});

export const deleteNote = defineEndpoint({
  route: "DELETE /api/conversation-notes/:conversationId",
});
