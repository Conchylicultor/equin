import { eq } from "drizzle-orm";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { pinQueue } from "../../core";
import { conversationsQueue } from "./tables";
import {
  lockDeck,
  rankForTop,
  seatJoiningGroup,
  setGroupPinned,
  upsertRank,
} from "./queue-ranks";

// Pin / unpin the conversation's task group. A pinned conversation stays an
// ordinary queue member — it keeps its rank and stays reorderable; the pin only
// decides which section it is read out under, so unpinning puts it back exactly
// where it was.
//
// Pinning an UNRANKED conversation seeds a rank first (the same path `rerank`
// takes), so the pin works from every section rather than being unavailable on
// the one list where "bring this to the top" is most useful. An
// already-ranked conversation keeps its rank untouched.
export const handlePin = implement(pinQueue, async ({ body }) => {
  const { conversationId, pinned } = body;
  const conv = await getConversation(conversationId);
  if (!conv) throw new HttpError(404, "Not found");

  await db.transaction(async (tx) => {
    await lockDeck(tx);

    const [existing] = await tx
      .select({ rank: conversationsQueue.table.rank })
      .from(conversationsQueue.table)
      .where(eq(conversationsQueue.table.conversationId, conversationId))
      .limit(1);
    if (!existing && pinned) {
      // Join the task's group if it already holds a seat, else enter at the top.
      const seat = await seatJoiningGroup(conv.taskId, conversationId, tx);
      const rank = seat?.rank ?? (await rankForTop(conversationId, tx));
      await upsertRank(conversationId, rank, tx);
    }

    await setGroupPinned(conversationId, pinned, tx);
  });
});
