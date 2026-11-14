import { asc, eq, inArray } from "drizzle-orm";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { db } from "@plugins/database/server";
import {
  _conversations,
  _attempts,
  listBlockingDepIdsOf,
} from "@plugins/tasks/plugins/tasks-core/server";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationsQueue } from "./tables";
import {
  lockDeck,
  rankAfterBlockers,
  reseatGroupMembers,
  upsertRank,
} from "./queue-ranks";

const LIVE_STATUSES: ConversationStatus[] = ["waiting", "working", "starting"];

export async function repairBlockedOrder(): Promise<void> {
  await db.transaction(async (tx) => {
    await lockDeck(tx);

    const _cq = conversationsQueue.table;
    let madeChanges = true;

    while (madeChanges) {
      madeChanges = false;

      const rows = await tx
        .select({
          convId: _cq.conversationId,
          rank: _cq.rank,
          taskId: _attempts.taskId,
        })
        .from(_cq)
        .innerJoin(_conversations, eq(_conversations.id, _cq.conversationId))
        .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
        .where(inArray(_conversations.status, LIVE_STATUSES))
        .orderBy(asc(_cq.rank));

      const taskLeads = new Map<string, { convId: string; rank: string }>();
      for (const row of rows) {
        if (!taskLeads.has(row.taskId)) {
          taskLeads.set(row.taskId, { convId: row.convId, rank: row.rank });
        }
      }

      // Which leads sit at or before a live conversation of a task blocking
      // them, judged from the rows above and ONE read of every lead's
      // blockers — never a read per task group: this runs at every boot
      // under the deck lock, and on a steady deck it moves nothing.
      const blockersByTask = await listBlockingDepIdsOf(
        [...taskLeads.keys()],
        tx,
      );
      const lastRankByTask = new Map<string, Rank>();
      for (const row of rows)
        lastRankByTask.set(row.taskId, Rank.from(row.rank));

      for (const [taskId, lead] of taskLeads) {
        const blockingTaskIds = blockersByTask.get(taskId);
        if (blockingTaskIds === undefined) continue;
        const currentRank = Rank.from(lead.rank);
        const behindABlocker = blockingTaskIds.some((blocker) => {
          const last = lastRankByTask.get(blocker);
          return last !== undefined && Rank.compare(currentRank, last) <= 0;
        });
        if (!behindABlocker) continue;

        const requiredRank = await rankAfterBlockers(
          lead.convId,
          blockingTaskIds,
          tx,
        );
        await upsertRank(lead.convId, requiredRank, tx);
        await reseatGroupMembers(lead.convId, requiredRank, tx);
        madeChanges = true;
      }
    }
  });
}
