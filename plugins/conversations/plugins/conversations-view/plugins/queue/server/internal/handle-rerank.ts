import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { rerankQueue } from "../../core";
import { lockDeck, rankForTop, seatJoiningGroup, upsertRank } from "./queue-ranks";

export const handleRerank = implement(rerankQueue, async ({ body }) => {
  const { conversationId } = body;
  const conv = await getConversation(conversationId);
  if (!conv) throw new HttpError(404, "Not found");

  await db.transaction(async (tx) => {
    await lockDeck(tx);
    // If the task already has a group in the queue, take its seat; else go to top.
    const seat = await seatJoiningGroup(conv.taskId, conversationId, tx);
    const rank = seat?.rank ?? (await rankForTop(conversationId, tx));
    await upsertRank(conversationId, rank, tx, seat?.pinned ?? false);
  });
});
