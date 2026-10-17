import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskLaunchServer } from "@plugins/tasks/plugins/launch-options/server";
import { taskWorkspacesServed } from "./internal/resource";
import {
  handlePutTaskWorkspace,
  handleDeleteTaskWorkspace,
} from "./internal/routes";
import { parseTaskWorkspace, setTaskWorkspace } from "./internal/mutations";
import { putTaskWorkspace, deleteTaskWorkspace } from "../shared/endpoints";
import { workspaceLaunchOption } from "../core";

export { tasksWorkspace } from "./internal/tables";
export { getTaskWorkspace, setTaskWorkspace } from "./internal/mutations";

export default {
  description:
    "Owns the tasks_ext_workspace side-table: the workspace (worktree, or a scratch profile) a task's next attempt runs in, read when the attempt is created.",
  contributions: [
    ...taskWorkspacesServed.declare,
    TaskLaunchServer({
      def: workspaceLaunchOption,
      // An unknown profile, or one whose input has no defaults, is a 400
      // before the task is filed.
      validate: (spec) => {
        if (spec) parseTaskWorkspace(spec);
      },
      apply: ({ taskId }, spec) => setTaskWorkspace(taskId, spec),
      // NO `inherit`: a task an agent files from a scratch task is not
      // implicitly scratch — the omission is the declaration.
    }),
  ],
  httpRoutes: {
    [putTaskWorkspace.route]: handlePutTaskWorkspace,
    [deleteTaskWorkspace.route]: handleDeleteTaskWorkspace,
  },
} satisfies ServerPluginDefinition;
