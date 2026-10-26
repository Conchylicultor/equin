import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { tasksView } from "@plugins/tasks/plugins/tasks-core/server";
import type { LaunchDecision } from "../../core";
import { AWAITING_LAUNCH_STATUS } from "./catalog-status";
import { tasksLaunchDecision, tasksOrigin } from "./tables";

const d = tasksLaunchDecision.table;
const o = tasksOrigin.table;

/**
 * The tasks a person approved for launch. The ONLY set a launch-kind run
 * launches from: candidates outside it never start, whatever the automation
 * ranked first. An approval is the task's, not one automation's — each run
 * intersects it with its own candidates, so nothing outside them launches.
 */
export async function approvedTaskIds(
  exec: DbExecutor = db,
): Promise<Set<string>> {
  const rows = await exec
    .select({ taskId: d.taskId })
    .from(d)
    .where(eq(d.decision, "approved"));
  return new Set(rows.map((r) => r.taskId));
}

/** Whether a person approved `taskId` for launch. */
export async function isTaskApproved(
  taskId: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const rows = await exec
    .select({ taskId: d.taskId })
    .from(d)
    .where(and(eq(d.taskId, taskId), eq(d.decision, "approved")));
  return rows.length > 0;
}

/**
 * How many approved tasks still wait for a launch: approved, no automation
 * launched or filed them yet (no origin row), and still `new` — a done,
 * dropped or already-started task is not waiting on an automation, so it must
 * not inflate the count.
 */
export async function pendingApprovalCount(
  exec: DbExecutor = db,
): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(d)
    .innerJoin(tasksView, eq(tasksView.id, d.taskId))
    .leftJoin(o, eq(o.taskId, d.taskId))
    .where(
      and(
        eq(d.decision, "approved"),
        isNull(o.taskId),
        eq(tasksView.status, AWAITING_LAUNCH_STATUS),
      ),
    );
  if (row === undefined) throw new Error("count() returned no row");
  return row.n;
}

/**
 * Record a person's decision on `taskIds` — `null` clears it (back to
 * undecided). Called only from the person's click (`decideLaunchEndpoint`);
 * nothing on the server approves a task.
 */
export async function decideLaunch(
  taskIds: readonly string[],
  decision: LaunchDecision | null,
  exec: DbExecutor = db,
): Promise<void> {
  if (taskIds.length === 0) return;
  if (decision === null) {
    await exec.delete(d).where(inArray(d.taskId, [...taskIds]));
    return;
  }
  const decidedAt = new Date();
  await exec.transaction(async (tx) => {
    for (const taskId of taskIds) {
      await tasksLaunchDecision.upsert(taskId, { decision, decidedAt }, tx);
    }
  });
}

/**
 * A person approves one task, or takes the approval back
 * (`taskApprovalEndpoint`). Approving overwrites an `excluded` row; taking it
 * back deletes only an `approved` one, so an exclusion is never erased by it.
 */
export async function setTaskApproval(
  taskId: string,
  approved: boolean,
  exec: DbExecutor = db,
): Promise<void> {
  if (approved) {
    await tasksLaunchDecision.upsert(
      taskId,
      { decision: "approved", decidedAt: new Date() },
      exec,
    );
    return;
  }
  await exec
    .delete(d)
    .where(and(eq(d.taskId, taskId), eq(d.decision, "approved")));
}
