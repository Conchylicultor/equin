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
