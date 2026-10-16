import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import {
  DEFAULT_WORKSPACE,
  WorkspaceSpecSchema,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";

// One task's chosen workspace, stored in the `tasks_ext_workspace`
// entity-extension table (1:1 per task). No row = the default worktree.
export const taskWorkspaceShape = defineExtensionShape({
  key: "taskId",
  fields: {
    spec: jsonField<WorkspaceSpec>({
      schema: WorkspaceSpecSchema,
      default: DEFAULT_WORKSPACE,
    }),
  },
  wireTimestamps: ["updatedAt"],
});
export const TaskWorkspaceSchema = taskWorkspaceShape.schema;
export type TaskWorkspace = z.infer<typeof TaskWorkspaceSchema>;

// Lookup-only, like task-preprompts: every reader asks about ONE task (the
// launch option's picker reads and writes this row), so a point read keyed by
// the task id. `found: false` = the default worktree.
export const taskWorkspaces = liveCollection("task-workspaces", {
  row: TaskWorkspaceSchema,
  id: "taskId",
});
