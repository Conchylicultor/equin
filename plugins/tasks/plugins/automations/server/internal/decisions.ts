import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { LaunchDecision } from "../../core";
import { tasksLaunchDecision, tasksOrigin } from "./tables";

const d = tasksLaunchDecision.table;
const o = tasksOrigin.table;

/**
 * The tasks a person approved `automationId` to launch. The ONLY set a
 * launch-kind run launches from: candidates outside it never start, whatever
 * the automation ranked first.
 */
export async function approvedTaskIds(
  automationId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ taskId: d.taskId })
    .from(d)
    .where(and(eq(d.automationId, automationId), eq(d.decision, "approved")));
  return new Set(rows.map((r) => r.taskId));
}

/**
 * How many tasks each automation has approved and not launched yet (no origin
 * row), keyed by automation id (absent ⇒ none).
 */
export async function pendingApprovalCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ automationId: d.automationId, n: count() })
    .from(d)
    .leftJoin(o, eq(o.taskId, d.taskId))
    .where(and(eq(d.decision, "approved"), isNull(o.taskId)))
    .groupBy(d.automationId);
  return new Map(rows.map((r) => [r.automationId, r.n]));
}

/**
 * Record a person's decision on `taskIds` for `automationId` — `null` clears
 * it (back to undecided). Called only from the person's click
 * (`decideLaunchEndpoint`); nothing on the server approves a task.
 */
export async function decideLaunch(
  automationId: string,
  taskIds: readonly string[],
  decision: LaunchDecision | null,
): Promise<void> {
  if (taskIds.length === 0) return;
  if (decision === null) {
    await db
      .delete(d)
      .where(
        and(eq(d.automationId, automationId), inArray(d.taskId, [...taskIds])),
      );
    return;
  }
  const decidedAt = new Date();
  await db.transaction(async (tx) => {
    for (const taskId of taskIds) {
      await tasksLaunchDecision.upsert(
        taskId,
        { automationId, decision, decidedAt },
        tx,
      );
    }
  });
}
