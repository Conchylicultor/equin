import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { WorkspaceSpecSchema } from "@plugins/conversations/plugins/workspace/core";

export const putTaskWorkspace = defineEndpoint({
  route: "PUT /api/task-workspaces/:taskId",
  body: z.object({ spec: WorkspaceSpecSchema }),
});

export const deleteTaskWorkspace = defineEndpoint({
  route: "DELETE /api/task-workspaces/:taskId",
});
