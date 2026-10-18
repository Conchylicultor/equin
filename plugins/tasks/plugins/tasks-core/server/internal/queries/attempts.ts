import { asc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _attemptDeliveries, _attempts } from "../tables";
import { attempts } from "../views";
import type { Attempt } from "../schema";
import type { DbExecutor } from "../status-batch";

export async function listAttempts(): Promise<Attempt[]> {
  return db.select().from(attempts).orderBy(asc(attempts.createdAt));
}

export async function getAttempt(id: string): Promise<Attempt | null> {
  const [row] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * One attempt's own row — the `attempts` TABLE (id, task, worktree path,
 * timestamps), none of `attempts_v`'s derived status. For a live loader that
 * needs only those facts (commits-graph's worktree, attempt-work's worktree
 * and lifetime): its captured read-set is then `attempts` alone, where
 * `attempts_v` would add the rollups' sources — every conversation and push
 * write would recompute it (C36).
 */
export async function getAttemptRow(
  id: string,
): Promise<typeof _attempts.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(_attempts)
    .where(eq(_attempts.id, id))
    .limit(1);
  return row ?? null;
}

// `exec`: read on a caller's transaction when the answer gates a write in it
// (the auto-launch's "did a manual start win?" check).
export async function listAttemptsForTask(
  taskId: string,
  exec: DbExecutor = db,
): Promise<Attempt[]> {
  return exec
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(asc(attempts.createdAt));
}

/**
 * Whether a scratch attempt recorded its delivery (`recordScratchDelivery`) —
 * the "landed" fact of a workspace with no git. Reads the `attempt_deliveries`
 * TABLE alone, so a live loader's read-set stays that table.
 */
export async function hasAttemptDelivery(attemptId: string): Promise<boolean> {
  const [row] = await db
    .select({ attemptId: _attemptDeliveries.attemptId })
    .from(_attemptDeliveries)
    .where(eq(_attemptDeliveries.attemptId, attemptId))
    .limit(1);
  return row !== undefined;
}
