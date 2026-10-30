import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { putBinding, deleteBinding } from "../../core";
import { _activeDataBindings } from "./tables";

function parseOccurrenceIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, "occurrenceIndex must be a non-negative integer");
  }
  return n;
}

export const handlePutBinding = implement(
  putBinding,
  async ({ params, body }) => {
    const occurrenceIndex = parseOccurrenceIndex(params.occurrenceIndex);

    await db
      .insert(_activeDataBindings)
      .values({
        conversationId: params.conversationId,
        messageId: params.messageId,
        tag: params.tag,
        occurrenceIndex,
        payload: body.payload,
      })
      .onConflictDoUpdate({
        target: [
          _activeDataBindings.conversationId,
          _activeDataBindings.messageId,
          _activeDataBindings.tag,
          _activeDataBindings.occurrenceIndex,
        ],
        // `updatedAt` is derived: the trigger bumps it only when payload changes.
        set: { payload: body.payload },
      });
  },
);

export const handleDeleteBinding = implement(
  deleteBinding,
  async ({ params }) => {
    const occurrenceIndex = parseOccurrenceIndex(params.occurrenceIndex);

    await db
      .delete(_activeDataBindings)
      .where(
        and(
          eq(_activeDataBindings.conversationId, params.conversationId),
          eq(_activeDataBindings.messageId, params.messageId),
          eq(_activeDataBindings.tag, params.tag),
          eq(_activeDataBindings.occurrenceIndex, occurrenceIndex),
        ),
      );
  },
);
