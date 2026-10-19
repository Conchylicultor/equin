import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ConversationRuntimeIdSchema } from "@plugins/conversations/plugins/runtime-catalog/core";

export const putTaskRuntime = defineEndpoint({
  route: "PUT /api/task-runtimes/:taskId",
  body: z.object({ runtime: ConversationRuntimeIdSchema }),
});

export const deleteTaskRuntime = defineEndpoint({
  route: "DELETE /api/task-runtimes/:taskId",
});
