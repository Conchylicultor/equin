import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { removeRow, upsertRow } from "@plugins/network/plugins/live/core";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";
import { taskWorkspaces } from "./schemas";

export const putTaskWorkspace = defineEndpoint({
  route: "PUT /api/task-workspaces/:taskId",
  body: z.object({ spec: WorkspaceSpecSchema }),
  // The workspace row may be absent (the default worktree): an upsert.
  effect: (on) =>
    upsertRow(
      on,
      taskWorkspaces,
      ({ params }) => params.taskId,
      (row, { params, body }) => ({
        taskId: params.taskId,
        updatedAt: new Date(),
        ...row,
        spec: body.spec,
      }),
      { set: ({ body }) => ({ spec: body.spec }) },
    ),
});

export const deleteTaskWorkspace = defineEndpoint({
  route: "DELETE /api/task-workspaces/:taskId",
  effect: (on) => removeRow(on, taskWorkspaces, ({ params }) => params.taskId),
});
