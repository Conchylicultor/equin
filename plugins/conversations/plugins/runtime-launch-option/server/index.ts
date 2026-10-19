import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskLaunchServer } from "@plugins/tasks/plugins/launch-options/server";
import { taskRuntimesServed } from "./internal/resource";
import {
  handlePutTaskRuntime,
  handleDeleteTaskRuntime,
} from "./internal/routes";
import { setTaskRuntime } from "./internal/mutations";
import { putTaskRuntime, deleteTaskRuntime } from "../shared/endpoints";
import { runtimeLaunchOption } from "../core";

export { getTaskRuntime } from "./internal/mutations";

export default {
  description:
    "Owns the tasks_ext_runtime side-table: the runtime (tmux or the Agent SDK) a task's conversations start on, read when one is launched — absent, the configured default.",
  contributions: [
    ...taskRuntimesServed.declare,
    TaskLaunchServer({
      def: runtimeLaunchOption,
      apply: ({ taskId }, runtime) => setTaskRuntime(taskId, runtime),
      // NO `inherit`: a task an agent files runs on the default runtime unless
      // its own launch picks one — the omission is the declaration.
    }),
  ],
  httpRoutes: {
    [putTaskRuntime.route]: handlePutTaskRuntime,
    [deleteTaskRuntime.route]: handleDeleteTaskRuntime,
  },
} satisfies ServerPluginDefinition;
