import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { removeRow, upsertRow } from "@plugins/network/plugins/live/core";
import { taskPreprompts } from "./schemas";

const PutTaskPrepromptBodySchema = z.object({
  prepromptId: z.string().min(1),
});

export const putTaskPreprompt = defineEndpoint({
  route: "PUT /api/task-preprompts/:taskId",
  body: PutTaskPrepromptBodySchema,
  // The selection row may be absent (none selected yet): an upsert.
  effect: (on) =>
    upsertRow(
      on,
      taskPreprompts,
      ({ params }) => params.taskId,
      (row, { params, body }) => ({
        taskId: params.taskId,
        updatedAt: new Date(),
        ...row,
        prepromptId: body.prepromptId,
      }),
      { set: ({ body }) => ({ prepromptId: body.prepromptId }) },
    ),
});

export const deleteTaskPreprompt = defineEndpoint({
  route: "DELETE /api/task-preprompts/:taskId",
  effect: (on) => removeRow(on, taskPreprompts, ({ params }) => params.taskId),
});
