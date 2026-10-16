import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskWorkspaceShape } from "../../shared/schemas";

// Per-task chosen workspace. Absent = the default worktree.
export const tasksWorkspace = defineExtension(
  _tasks,
  "workspace",
  taskWorkspaceShape,
);
export const _tasksWorkspaceExt = tasksWorkspace.table;
