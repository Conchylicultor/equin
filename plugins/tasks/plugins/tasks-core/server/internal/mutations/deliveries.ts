import { eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _attemptDeliveries, _attempts, _conversations } from "../tables";
import { withTaskStatusChange } from "../status-scope";

/**
 * Record that a scratch conversation delivered its work — a scratch workspace
 * has no git, so this row is its "landed" fact where a worktree's is a push:
 * once no agent is working on the attempt (its turn ended, or its conversation
 * hibernated or closed) it reads `completed`, and its task `done` — the
 * conversation may stay open for a follow-up (derived.ts, rollup-spec.ts
 * `attempt_push_agg`). A fact, never a status (I6).
 *
 * Idempotent per attempt: a second delivery replaces the summary and keeps the
 * first instant. Throws for an unknown conversation, and for one whose
 * workspace is not scratch (a worktree delivers by pushing).
 */
export async function recordScratchDelivery(
  conversationId: string,
  { summary }: { summary: string },
): Promise<void> {
  const [row] = await db
    .select({
      attemptId: _attempts.id,
      taskId: _attempts.taskId,
      workspace: _attempts.workspace,
    })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(eq(_conversations.id, conversationId))
    .limit(1);
  if (!row) throw new Error(`Unknown conversation "${conversationId}"`);
  if (row.workspace.kind !== "scratch") {
    throw new Error(
      `Conversation ${conversationId} runs in a ${row.workspace.kind} workspace, which delivers by pushing, not by a recorded delivery`,
    );
  }
  await withTaskStatusChange(row.taskId, db, async () => {
    await db
      .insert(_attemptDeliveries)
      .values({ attemptId: row.attemptId, conversationId, summary })
      .onConflictDoUpdate({
        target: _attemptDeliveries.attemptId,
        set: {
          conversationId: sql`excluded.conversation_id`,
          summary: sql`excluded.summary`,
        },
      });
  });
}
