import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const PutTaskPrepromptBodySchema = z.object({
  prepromptId: z.string().min(1),
});

export const putTaskPreprompt = defineEndpoint({
  route: "PUT /api/task-preprompts/:taskId",
  body: PutTaskPrepromptBodySchema,
});

export const deleteTaskPreprompt = defineEndpoint({
  route: "DELETE /api/task-preprompts/:taskId",
});
