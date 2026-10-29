import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { removeRow, upsertRow } from "@plugins/network/plugins/live/core";
import { conversationNoteRows } from "../core";

const UpsertNoteBodySchema = z.object({
  notes: z.string().min(1),
});

export const upsertNote = defineEndpoint({
  route: "PUT /api/conversation-notes/:conversationId",
  body: UpsertNoteBodySchema,
  // The note row may be absent (no note yet): an upsert.
  effect: (on) =>
    upsertRow(
      on,
      conversationNoteRows,
      ({ params }) => params.conversationId,
      (row, { params, body }) => ({
        conversationId: params.conversationId,
        updatedAt: new Date(),
        ...row,
        notes: body.notes,
      }),
      { set: ({ body }) => ({ notes: body.notes }) },
    ),
});

export const deleteNote = defineEndpoint({
  route: "DELETE /api/conversation-notes/:conversationId",
  effect: (on) =>
    removeRow(on, conversationNoteRows, ({ params }) => params.conversationId),
});
