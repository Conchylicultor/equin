import { and, asc, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { db } from "@plugins/database/server";
import {
  _conversations,
  _attempts,
} from "@plugins/tasks/plugins/tasks-core/server";
import type { RankExecutor } from "@plugins/primitives/plugins/rank/server";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationsQueue } from "./tables";

const _conversationsExtQueue = conversationsQueue.table;

const LIVE_STATUSES: ConversationStatus[] = ["waiting", "working", "starting"];

function joinedLive(executor: RankExecutor = db) {
  return executor
    .select({
      rank: _conversationsExtQueue.rank,
      id: _conversationsExtQueue.conversationId,
    })
    .from(_conversationsExtQueue)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationsExtQueue.conversationId),
    );
}

function safeBetween(prev: Rank | null, next: Rank | null): Rank {
  if (prev && next && Rank.equals(prev, next)) {
    return Rank.between(prev, null);
  }
  return Rank.between(prev, next);
}

export async function endRank(): Promise<Rank> {
  const [last] = await joinedLive()
    .where(inArray(_conversations.status, LIVE_STATUSES))
    .orderBy(desc(_conversationsExtQueue.rank))
    .limit(1);
  return Rank.between(last?.rank ? Rank.from(last.rank as string) : null, null);
}

export async function lockDeck(executor: RankExecutor): Promise<void> {
  await executor
    .select({ id: _conversationsExtQueue.conversationId })
    .from(_conversationsExtQueue)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationsExtQueue.conversationId),
    )
    .where(inArray(_conversations.status, LIVE_STATUSES))
    .for("update", { of: _conversationsExtQueue });
}

export async function rankForTop(
  excludeId: string,
  executor: RankExecutor = db,
): Promise<Rank> {
  const [first] = await joinedLive(executor)
    .where(
      and(
        inArray(_conversations.status, LIVE_STATUSES),
        ne(_conversationsExtQueue.conversationId, excludeId),
      ),
    )
    .orderBy(asc(_conversationsExtQueue.rank))
    .limit(1);
  return Rank.between(
    null,
    first?.rank ? Rank.from(first.rank as string) : null,
  );
}

export async function rankForBottom(
  excludeId: string,
  executor: RankExecutor = db,
): Promise<Rank> {
  const [last] = await joinedLive(executor)
    .where(
      and(
        inArray(_conversations.status, LIVE_STATUSES),
        ne(_conversationsExtQueue.conversationId, excludeId),
      ),
    )
    .orderBy(desc(_conversationsExtQueue.rank))
    .limit(1);
  return Rank.between(last?.rank ? Rank.from(last.rank as string) : null, null);
}

// Skips N distinct task groups below the current position.
export async function rankAfterN(
  conversationId: string,
  n: number,
  executor: RankExecutor = db,
): Promise<Rank> {
  const [self] = await executor
    .select({ rank: _conversationsExtQueue.rank })
    .from(_conversationsExtQueue)
    .where(eq(_conversationsExtQueue.conversationId, conversationId))
    .limit(1);
  if (!self?.rank) return rankForBottom(conversationId, executor);

  const taskId = await findTaskIdForConversation(conversationId, executor);
  const selfRank = Rank.from(self.rank as string);

  const conditions = [
    inArray(_conversations.status, LIVE_STATUSES),
    ne(_conversationsExtQueue.conversationId, conversationId),
  ];
  if (taskId) conditions.push(ne(_attempts.taskId, taskId));

  const rows = await executor
    .select({
      rank: _conversationsExtQueue.rank,
      taskId: _attempts.taskId,
    })
    .from(_conversationsExtQueue)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationsExtQueue.conversationId),
    )
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(and(...conditions))
    .orderBy(asc(_conversationsExtQueue.rank));

  // Deduplicate by taskId — each group counts once regardless of member count.
  const seen = new Set<string>();
  const repsBelow: Rank[] = [];
  for (const row of rows) {
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    const r = Rank.from(row.rank as string);
    if (Rank.compare(r, selfRank) > 0) {
      repsBelow.push(r);
    }
  }

  if (repsBelow.length < n) return rankForBottom(conversationId, executor);

  return Rank.between(repsBelow[n - 1]!, repsBelow[n] ?? null);
}

// Insert before or after the target group's shared rank.
export async function rankAdjacentTo(
  targetId: string,
  zone: "before" | "after",
  executor: RankExecutor = db,
): Promise<Rank> {
  const [target] = await executor
    .select({ rank: _conversationsExtQueue.rank })
    .from(_conversationsExtQueue)
    .where(eq(_conversationsExtQueue.conversationId, targetId))
    .limit(1);
  if (!target?.rank)
    throw new Error(`No queue rank for conversation ${targetId}`);

  if (zone === "before") {
    const [pred] = await executor
      .select({ rank: _conversationsExtQueue.rank })
      .from(_conversationsExtQueue)
      .innerJoin(
        _conversations,
        eq(_conversations.id, _conversationsExtQueue.conversationId),
      )
      .where(
        and(
          inArray(_conversations.status, LIVE_STATUSES),
          lt(_conversationsExtQueue.rank, target.rank),
        ),
      )
      .orderBy(desc(_conversationsExtQueue.rank))
      .limit(1);

    return safeBetween(
      pred?.rank ? Rank.from(pred.rank as string) : null,
      Rank.from(target.rank as string),
    );
  } else {
    const [succ] = await executor
      .select({ rank: _conversationsExtQueue.rank })
      .from(_conversationsExtQueue)
      .innerJoin(
        _conversations,
        eq(_conversations.id, _conversationsExtQueue.conversationId),
      )
      .where(
        and(
          inArray(_conversations.status, LIVE_STATUSES),
          gt(_conversationsExtQueue.rank, target.rank),
        ),
      )
      .orderBy(asc(_conversationsExtQueue.rank))
      .limit(1);

    return safeBetween(
      Rank.from(target.rank as string),
      succ?.rank ? Rank.from(succ.rank as string) : null,
    );
  }
}

export async function rankAfterBlockers(
  conversationId: string,
  blockingTaskIds: string[],
  executor: RankExecutor = db,
): Promise<Rank> {
  if (blockingTaskIds.length === 0) return rankForTop(conversationId, executor);

  const [last] = await executor
    .select({ rank: _conversationsExtQueue.rank })
    .from(_conversationsExtQueue)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationsExtQueue.conversationId),
    )
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(
      and(
        inArray(_conversations.status, LIVE_STATUSES),
        ne(_conversationsExtQueue.conversationId, conversationId),
        inArray(_attempts.taskId, blockingTaskIds),
      ),
    )
    .orderBy(desc(_conversationsExtQueue.rank))
    .limit(1);

  if (!last?.rank) return rankForTop(conversationId, executor);

  const [succ] = await joinedLive(executor)
    .where(
      and(
        inArray(_conversations.status, LIVE_STATUSES),
        ne(_conversationsExtQueue.conversationId, conversationId),
        gt(_conversationsExtQueue.rank, last.rank),
      ),
    )
    .orderBy(asc(_conversationsExtQueue.rank))
    .limit(1);

  return safeBetween(
    Rank.from(last.rank as string),
    succ?.rank ? Rank.from(succ.rank as string) : null,
  );
}

// --- Task group helpers ---

export async function findTaskIdForConversation(
  conversationId: string,
  executor: RankExecutor = db,
): Promise<string | null> {
  const [row] = await executor
    .select({ taskId: _attempts.taskId })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(eq(_conversations.id, conversationId))
    .limit(1);
  return row?.taskId ?? null;
}

async function findGroupSiblingIds(
  taskId: string,
  excludeId: string,
  executor: RankExecutor = db,
): Promise<string[]> {
  const rows = await executor
    .select({ id: _conversationsExtQueue.conversationId })
    .from(_conversationsExtQueue)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationsExtQueue.conversationId),
    )
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(
      and(
        eq(_attempts.taskId, taskId),
        ne(_conversationsExtQueue.conversationId, excludeId),
        inArray(_conversations.status, LIVE_STATUSES),
      ),
    );
  return rows.map((r) => r.id);
}

// Sets all same-task siblings to the same rank as the moved conversation.
export async function reseatGroupMembers(
  targetId: string,
  targetNewRank: Rank,
  executor: RankExecutor,
): Promise<void> {
  const taskId = await findTaskIdForConversation(targetId, executor);
  if (!taskId) return;

  const siblingIds = await findGroupSiblingIds(taskId, targetId, executor);
  for (const id of siblingIds) {
    await upsertRank(id, targetNewRank, executor);
  }
}

/** The queue state a task group shares: one position, one section. */
export interface GroupSeat {
  rank: Rank;
  /** `PINNED_SECTION`, a user section's id, or `null` (the Queue). */
  section: string | null;
}

// Returns the seat of the task group so a conversation joining it lands in the
// same position AND the same section. Rank and section are read together on
// purpose: both are group-level, so a caller that could inherit one without the
// other would split the group across two sections. Null if the task has no
// existing ranked members.
export async function seatJoiningGroup(
  taskId: string,
  conversationId: string,
  executor: RankExecutor = db,
): Promise<GroupSeat | null> {
  const [existing] = await executor
    .select({
      rank: _conversationsExtQueue.rank,
      section: _conversationsExtQueue.section,
    })
    .from(_conversationsExtQueue)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationsExtQueue.conversationId),
    )
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(
      and(
        eq(_attempts.taskId, taskId),
        ne(_conversationsExtQueue.conversationId, conversationId),
        inArray(_conversations.status, LIVE_STATUSES),
      ),
    )
    .limit(1);

  if (!existing?.rank) return null;
  return {
    rank: Rank.from(existing.rank as string),
    section: existing.section,
  };
}

// Writes a conversation's position. `section` is deliberately NOT touched on an
// existing row: every caller here is moving a row around, and a move must not
// silently change which section the row is in. It is only written when the row
// is first inserted (seat inheritance goes through `seatJoiningGroup`); the
// section itself is set through `setGroupSection`.
export async function upsertRank(
  conversationId: string,
  rank: Rank,
  executor: RankExecutor = db,
  section: string | null = null,
): Promise<void> {
  await executor
    .insert(_conversationsExtQueue)
    .values({ conversationId, rank: rank.toJSON(), section })
    .onConflictDoUpdate({
      target: _conversationsExtQueue.conversationId,
      set: { rank: rank.toJSON() },
    });
}

// Files every live member of the conversation's task group into `section` —
// the same group-level treatment `reseatGroupMembers` gives the rank, because
// the sidebar shows a group as ONE row: a per-member section could split one
// group across two sections. The caller checks a user section id exists.
export async function setGroupSection(
  conversationId: string,
  section: string | null,
  executor: RankExecutor,
): Promise<void> {
  const taskId = await findTaskIdForConversation(conversationId, executor);
  const siblingIds = taskId
    ? await findGroupSiblingIds(taskId, conversationId, executor)
    : [];
  await executor
    .update(_conversationsExtQueue)
    .set({ section })
    .where(
      inArray(_conversationsExtQueue.conversationId, [
        conversationId,
        ...siblingIds,
      ]),
    );
}
