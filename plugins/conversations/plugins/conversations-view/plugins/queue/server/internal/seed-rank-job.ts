import { z } from "zod";
import { eq } from "drizzle-orm";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  lockDeck,
  rankForTop,
  seatJoiningGroup,
  findTaskIdForConversation,
  upsertRank,
} from "./queue-ranks";
import { db } from "@plugins/database/server";
import { conversationsQueue } from "./tables";
import { launchSectionFor } from "./launch-section";

export const seedRankJob = defineJob({
  name: "queue.seed-rank",
  description:
    "Gives each new conversation its place in the queue, joining its task's group when one exists.",
  hold: "instant",
  input: z.object({}).passthrough(),
  event: z.object({ conversationId: z.string() }).passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ event }) => {
    const conversationId = event?.conversationId;
    if (!conversationId) return;

    await db.transaction(async (tx) => {
      await lockDeck(tx);

      const [existing] = await tx
        .select({ rank: conversationsQueue.table.rank })
        .from(conversationsQueue.table)
        .where(eq(conversationsQueue.table.conversationId, conversationId))
        .limit(1);
      if (existing) return;

      // If the task already has a group, take its seat — position AND section —
      // rather than going to top as a fresh row in the Queue.
      const taskId = await findTaskIdForConversation(conversationId, tx);
      const seat = taskId
        ? await seatJoiningGroup(taskId, conversationId, tx)
        : null;
      if (seat) {
        await upsertRank(conversationId, seat.rank, tx, seat.section);
        return;
      }
      // A fresh group: at the top, in the section a contributor files the
      // task's group into (a supervisor role's session), else the Queue.
      const section = taskId ? await launchSectionFor(taskId, tx) : null;
      await upsertRank(
        conversationId,
        await rankForTop(conversationId, tx),
        tx,
        section,
      );
    });
  },
});
