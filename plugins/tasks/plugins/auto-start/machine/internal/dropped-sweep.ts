import { inArray, isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { _tasksAutoStartExt } from "../../server/internal/tables";

// The legacy backlog: markers that were left on tasks dropped before the
// cancel-on-drop job (server/internal/cancel-on-drop.ts) existed. Idempotent
// and cheap, so it stays mounted as an ordinary warm-up rather than a one-shot
// migration — it also closes the gap for any drop that happened while this
// backend was down.
export async function sweepArmedDroppedTasks(): Promise<number> {
  const removed = await db
    .delete(_tasksAutoStartExt)
    .where(
      inArray(
        _tasksAutoStartExt.taskId,
        db
          .select({ id: _tasks.id })
          .from(_tasks)
          .where(isNotNull(_tasks.droppedAt)),
      ),
    )
    .returning({ taskId: _tasksAutoStartExt.taskId });
  if (removed.length > 0) {
    console.warn(
      `[tasks.auto-start] cleared ${removed.length} auto-start marker(s) on dropped task(s)`,
    );
  }
  return removed.length;
}

export const autoStartDroppedSweepWarmup = defineWarmup({
  name: "tasks.auto-start-dropped-sweep",
  description:
    "Clears leftover auto-launch markers from already-dropped tasks at startup.",
  scope: "host",
  run: async () => {
    await sweepArmedDroppedTasks();
  },
});
