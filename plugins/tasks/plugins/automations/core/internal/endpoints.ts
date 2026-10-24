import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { LAUNCH_DECISIONS } from "./settings";

/** The most tasks one decision click may cover (a review list's selection). */
export const MAX_DECIDED_TASKS = 200;

/**
 * A person decides on tasks from a launch-kind automation's list: approve them
 * (a launch automation may launch them), exclude them (not proposed again), or
 * clear the decision (`null`). The decision is the task's, not the
 * automation's: `:automationId` only names the list it was made from (it must
 * be a launch-kind automation, and is woken on an approval). With
 * `taskApprovalEndpoint`, the only writers of approvals — nothing on the server
 * approves a task.
 */
export const decideLaunchEndpoint = defineEndpoint({
  route: "POST /api/automations/:automationId/launch-decisions",
  body: z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(MAX_DECIDED_TASKS),
    decision: z.enum(LAUNCH_DECISIONS).nullable(),
  }),
});

/**
 * A person approves one task for launch, or takes the approval back — from the
 * task itself, whatever automation may launch it. `true` records `approved`
 * (overwriting an `excluded`); `false` clears only an `approved` row, so it
 * never silently erases an exclusion.
 */
export const taskApprovalEndpoint = defineEndpoint({
  route: "PUT /api/tasks/:taskId/approval",
  body: z.object({ approved: z.boolean() }),
});
