import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { promoteQueue } from "../../core";
import { lockDeck, rankForTop, reseatGroupMembers, upsertRank } from "./queue-ranks";

export const handlePromote = implement(promoteQueue, async ({ body }) => {
  const { conversationId } = body;
  const conv = await getConversation(conversationId);
  if (!conv) throw new HttpError(404, "Not found");

  await db.transaction(async (tx) => {
    await lockDeck(tx);
    const rank = await rankForTop(conversationId, tx);
    await upsertRank(conversationId, rank, tx);
    await reseatGroupMembers(conversationId, rank, tx);
  });
});
