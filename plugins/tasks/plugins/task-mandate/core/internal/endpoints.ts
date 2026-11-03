import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * State a named mandate as the task's own (the human override from the task
 * detail): it governs the task's subtree from the next request on — the
 * agents already running there included, since every grant is resolved live.
 */
export const putTaskMandate = defineEndpoint({
  route: "PUT /api/tasks/:taskId/mandate",
  body: z.object({ mandateId: z.string().min(1) }),
});

/**
 * Drop the task's own mandate, so it inherits its nearest ancestor's again.
 * Refused on a root: a root always states one.
 */
export const deleteTaskMandate = defineEndpoint({
  route: "DELETE /api/tasks/:taskId/mandate",
});
