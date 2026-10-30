import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { demoteQueue } from "../../core";
import { lockDeck, rankForBottom, reseatGroupMembers, upsertRank } from "./queue-ranks";
import { cascadeBlockedDependents } from "./cascade-blocked";

export const handleDemote = implement(demoteQueue, async ({ body }) => {
  const { conversationId } = body;
  const conv = await getConversation(conversationId);
  if (!conv) throw new HttpError(404, "Not found");

  await db.transaction(async (tx) => {
    await lockDeck(tx);
    const rank = await rankForBottom(conversationId, tx);
    await upsertRank(conversationId, rank, tx);
    await reseatGroupMembers(conversationId, rank, tx);
    await cascadeBlockedDependents(conversationId, tx);
  });
});
