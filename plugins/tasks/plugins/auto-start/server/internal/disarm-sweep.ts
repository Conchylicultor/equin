import { inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { tasksView } from "@plugins/tasks/plugins/tasks-core/server";
import { statusesDeciding } from "../../core";
import { _tasksAutoStartExt } from "./tables";

// The backlog `disarm-on-status` cannot reach: markers left on tasks whose
// status ruled a launch out before that job existed (dropped before
// cancel-on-drop, done or running before the status table), and any status
// change that happened while this backend was down. Idempotent and cheap — one
// `tasks_v` read — so it stays mounted as an ordinary warm-up rather than a
// one-shot migration.
export async function sweepDisarmedMarkers(): Promise<number> {
  const removed = await db
    .delete(_tasksAutoStartExt)
    .where(
      inArray(
        _tasksAutoStartExt.taskId,
        db
          .select({ id: tasksView.id })
          .from(tasksView)
          .where(inArray(tasksView.status, statusesDeciding("disarm"))),
      ),
    )
    .returning({ taskId: _tasksAutoStartExt.taskId });
  if (removed.length > 0) {
    console.warn(
      `[tasks.auto-start] cleared ${removed.length} auto-start marker(s) on task(s) whose status rules a launch out`,
    );
  }
  return removed.length;
}

export const autoStartDisarmSweepWarmup = defineWarmup({
  name: "tasks.auto-start-disarm-sweep",
  description:
    "Clears leftover auto-launch markers at startup from tasks that are dropped, done, or already running.",
  scope: "host",
  run: async () => {
    await sweepDisarmedMarkers();
  },
});
