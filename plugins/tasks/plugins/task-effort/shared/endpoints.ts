import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { removeRow, upsertRow } from "@plugins/network/plugins/live/core";
import { EffortLevelSchema } from "@plugins/conversations/plugins/effort-provider/core";
import { taskEfforts } from "./schemas";

const PutTaskEffortBodySchema = z.object({
  level: EffortLevelSchema,
});

export const putTaskEffort = defineEndpoint({
  route: "PUT /api/task-efforts/:taskId",
  body: PutTaskEffortBodySchema,
  // The mode row may be absent (no mode yet): an upsert.
  effect: (on) =>
    upsertRow(
      on,
      taskEfforts,
      ({ params }) => params.taskId,
      (row, { params, body }) => ({
        taskId: params.taskId,
        updatedAt: new Date(),
        ...row,
        level: body.level,
      }),
      { set: ({ body }) => ({ level: body.level }) },
    ),
});

export const deleteTaskEffort = defineEndpoint({
  route: "DELETE /api/task-efforts/:taskId",
  effect: (on) => removeRow(on, taskEfforts, ({ params }) => params.taskId),
});
