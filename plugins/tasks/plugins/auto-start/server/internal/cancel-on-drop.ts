import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { _tasksAutoStartExt } from "./tables";

// Dropping a task cancels its queued launch.
//
// Before, a dropped task kept its marker forever: the launch job bails on
// `droppedAt` BEFORE the claim, so nothing ever cleared it. Un-dropping such a
// task months later would surprise-launch an agent for intent the user had
// already abandoned. 104 of the ~180 markers on main are exactly that.
//
// This is only possible now because `tasks.statusChanged` became trustworthy:
// it is emitted for every task whose derived status actually changed, including
// the downstream tasks an edge edit or a subtree drop moved, so "this task is
// now dropped" reliably reaches a subscriber. Under the old convention-based
// emission the marker cleanup would have silently missed most drops.
//
// It lives in the auto-start plugin rather than in tasks-core because
// auto-start EXTENDS tasks-core; a direct call from tasks-core into the
// auto-start marker would invert that dependency.
export const cancelAutoStartOnDropJob = defineJob({
  name: "tasks.auto-start-cancel-on-drop",
  description:
    "Cancels a task's queued auto-launch when the task is dropped, so un-dropping it never launches an abandoned agent.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      taskId: z.string(),
      status: z.string(),
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (event.status !== "dropped") return;
    await db
      .delete(_tasksAutoStartExt)
      .where(eq(_tasksAutoStartExt.taskId, event.taskId));
  },
});
