import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { EffortLevelSchema } from "@plugins/conversations/plugins/effort-provider/core";

const PutTaskEffortBodySchema = z.object({
  level: EffortLevelSchema,
});

export const putTaskEffort = defineEndpoint({
  route: "PUT /api/task-efforts/:taskId",
  body: PutTaskEffortBodySchema,
});

export const deleteTaskEffort = defineEndpoint({
  route: "DELETE /api/task-efforts/:taskId",
});
