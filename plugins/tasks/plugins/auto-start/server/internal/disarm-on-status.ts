import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { TaskStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { autoStartDecision } from "../../core";
import { _tasksAutoStartExt } from "./tables";

// A task whose status now decides `disarm` (AUTO_START_DECISIONS) loses its
// queued launch: dropped, done, or with an agent running on it.
//
// The marker is otherwise consumed only by the queue's own claim. A task armed
// while blocked and then started by hand, or finished any other way, kept it
// forever — and the launcher woke it the day its last blocker went away: on
// 2026-11-04 five tasks that had landed in June launched again. (Before that,
// the same hole for drops: un-dropping a task months later surprise-launched
// an agent for intent the user had already abandoned.)
//
// Reliable because `tasks.statusChanged` is emitted for every task whose
// derived status actually changed, including the downstream tasks an edge edit
// or a subtree drop moved.
//
// It lives in the auto-start plugin rather than in tasks-core because
// auto-start EXTENDS tasks-core; a direct call from tasks-core into the
// auto-start marker would invert that dependency.
export const disarmAutoStartOnStatusJob = defineJob({
  name: "tasks.auto-start-disarm-on-status",
  description:
    "Cancels a task's queued auto-launch when its status rules a launch out (dropped, done, or an agent already running).",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      taskId: z.string(),
      status: TaskStatusSchema,
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (autoStartDecision(event.status) !== "disarm") return;
    await db
      .delete(_tasksAutoStartExt)
      .where(eq(_tasksAutoStartExt.taskId, event.taskId));
  },
});
