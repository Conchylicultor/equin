import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { LAUNCH_DECISIONS } from "./settings";

/** The most tasks one decision click may cover (a review list's selection). */
export const MAX_DECIDED_TASKS = 200;

/**
 * A person decides on tasks for a launch-kind automation: approve them (it may
 * launch them), exclude them (not proposed again), or clear the decision
 * (`null`). The only writer of approvals — nothing on the server approves a
 * task.
 */
export const decideLaunchEndpoint = defineEndpoint({
  route: "POST /api/automations/:automationId/launch-decisions",
  body: z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(MAX_DECIDED_TASKS),
    decision: z.enum(LAUNCH_DECISIONS).nullable(),
  }),
});
