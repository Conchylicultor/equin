import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import {
  _tasks,
  hasBlockingDep,
} from "@plugins/tasks/plugins/tasks-core/server";
import { tasksAutoStart, _tasksAutoStartExt } from "./tables";
import type { ModelChoice } from "@plugins/conversations/plugins/model-provider/core";

export async function getTaskAutoStart(id: string) {
  return tasksAutoStart.get(id);
}

// Every task id carrying an auto-start marker. Deliberately unfiltered — it is
// the input to the boot reconcile, whose whole point is to let
// `maybeLaunchTaskJob` be the ONE place that decides launchability. Bounded by
// the marker set, which is small (~180) and shrinks as tasks launch.
export async function listArmedTaskIds(): Promise<string[]> {
  const rows = await db
    .select({ taskId: _tasksAutoStartExt.taskId })
    .from(_tasksAutoStartExt);
  return rows.map((r) => r.taskId);
}

// Of `taskIds`, the armed ones that can launch on their own: neither held nor
// dropped, and with no blocking prerequisite — what will start an agent without
// anyone acting. On `exec`, so a caller's transaction sees its own writes.
export async function listLaunchableArmedIn(
  taskIds: readonly string[],
  exec: DbExecutor = db,
): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const armed = await exec
    .select({ taskId: _tasksAutoStartExt.taskId })
    .from(_tasksAutoStartExt)
    .innerJoin(_tasks, eq(_tasks.id, _tasksAutoStartExt.taskId))
    .where(
      and(
        inArray(_tasksAutoStartExt.taskId, [...taskIds]),
        isNull(_tasks.heldAt),
        isNull(_tasks.droppedAt),
      ),
    );
  const out: string[] = [];
  for (const { taskId } of armed) {
    if (!(await hasBlockingDep(taskId, exec))) out.push(taskId);
  }
  return out;
}

// Arm (or, with `null`, disarm) a task. An arm REPLACES the whole marker:
// `prompt` absent stores `null`, so a re-arm that names no prompt (the user
// picking a model, re-launching from the UI) launches with the task's own text
// and never inherits a prompt an automation wrote for an earlier arm.
export async function setTaskAutoStart(
  id: string,
  autoStart: { model: ModelChoice; prompt?: string } | null,
): Promise<boolean> {
  const [task] = await db
    .select({ id: _tasks.id })
    .from(_tasks)
    .where(eq(_tasks.id, id))
    .limit(1);
  if (!task) return false;
  if (autoStart) {
    const now = new Date();
    await tasksAutoStart.upsert(id, {
      autoStartAt: now,
      autoStartModel: autoStart.model,
      autoStartPrompt: autoStart.prompt ?? null,
    });
  } else {
    await tasksAutoStart.delete(id);
  }
  return true;
}

// Atomic CAS: delete the ext-table row and return true iff this caller
// won the race. Collapses at-least-once trigger delivery into exactly-one
// launch in maybeLaunchTaskJob.
//
// Run it on the launch's transaction (`exec`) so the claim and the launch
// commit together: the DELETE row-locks the marker, so a concurrent claimer
// blocks until this transaction ends — then finds the row gone (we committed)
// or claims it itself (we rolled back, and the marker came back with it).
export async function claimAutoStart(
  id: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const [row] = await exec
    .delete(_tasksAutoStartExt)
    .where(eq(_tasksAutoStartExt.taskId, id))
    .returning({ taskId: _tasksAutoStartExt.taskId });
  return !!row;
}
