import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _attemptDeliveries, _attempts, _tasks } from "../tables";
import { attempts } from "../views";
import type { Attempt } from "../schema";
import type { DbExecutor } from "../status-batch";

export async function listAttempts(): Promise<Attempt[]> {
  return db.select().from(attempts).orderBy(asc(attempts.createdAt));
}

/**
 * Whether each of these attempts is RETAINED (`attempts_v.retained`: the user
 * has not finished with it — no conversation closed for good, or none yet).
 * An id with no row is absent from the map: unknown here, never "not
 * retained" (a checkout another backend minted has its row in that backend's
 * database).
 */
export async function attemptRetention(
  ids: readonly string[],
): Promise<Map<string, boolean>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: attempts.id, retained: attempts.retained })
    .from(attempts)
    .where(inArray(attempts.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.retained]));
}

/** Where one attempt stands in its lifecycle, for a reaper deciding its leftovers. */
export interface AttemptEnding {
  /** The user has not finished with it (`attempts_v.retained`). */
  retained: boolean;
  /** When it finished (its conversations closed), if it did. */
  finishedAt: Date | null;
  /** When its task was dropped, if it was. */
  taskDroppedAt: Date | null;
}

/**
 * {@link AttemptEnding} of each of these attempts, in ONE read — a reaper
 * walking a directory per attempt asks for all of them at once, never an
 * attempt and a task read per directory (a `tasks_v` read is O(the whole
 * dependency graph) however few ids it names). The task's `dropped_at` is read
 * from the `tasks` TABLE: nothing derived is needed. An id with no row is
 * absent from the map (unknown here: another backend may hold it).
 */
export async function attemptEndings(
  ids: readonly string[],
): Promise<Map<string, AttemptEnding>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: attempts.id,
      retained: attempts.retained,
      finishedAt: attempts.finishedAt,
      taskDroppedAt: _tasks.droppedAt,
    })
    .from(attempts)
    .leftJoin(_tasks, eq(_tasks.id, attempts.taskId))
    .where(inArray(attempts.id, [...ids]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        retained: r.retained,
        finishedAt: r.finishedAt,
        taskDroppedAt: r.taskDroppedAt,
      },
    ]),
  );
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
