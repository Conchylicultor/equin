import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { stepDownQueue } from "../../core";
import { lockDeck, rankAfterN, reseatGroupMembers, upsertRank } from "./queue-ranks";
import { cascadeBlockedDependents } from "./cascade-blocked";

export const handleStepDown = implement(stepDownQueue, async ({ body }) => {
  const { conversationId, steps } = body;
  const conv = await getConversation(conversationId);
  if (!conv) throw new HttpError(404, "Not found");

  await db.transaction(async (tx) => {
    await lockDeck(tx);
    const rank = await rankAfterN(conversationId, steps, tx);
    await upsertRank(conversationId, rank, tx);
    await reseatGroupMembers(conversationId, rank, tx);
    await cascadeBlockedDependents(conversationId, tx);
  });
});
