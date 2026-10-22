import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskLaunchServer } from "@plugins/tasks/plugins/launch-options/server";
import { taskPrepromptsServed } from "./internal/resource";
import {
  handlePutTaskPreprompt,
  handleDeleteTaskPreprompt,
} from "./internal/routes";
import { setTaskPreprompt, inheritTaskPreprompt } from "./internal/mutations";
import { putTaskPreprompt, deleteTaskPreprompt } from "../shared/endpoints";
import { prepromptLaunchOption } from "../core";

export { tasksPreprompt } from "./internal/tables";
// `inheritTaskPreprompt` is deliberately NOT exported: inheritance is reached
// only through the launch-option registry's `inherit` verb, so no consumer can
// wire this option by name and drift from the others again.
export { getTaskPreprompt, setTaskPreprompt } from "./internal/mutations";

export default {
  portable: true,
  description:
    "Owns the tasks_ext_preprompt side-table: the per-task selected preprompt id, added to the agent's system prompt at launch, after Claude Code's own, as a <special_instructions> block.",
  contributions: [
    ...taskPrepromptsServed.declare,
    TaskLaunchServer({
      def: prepromptLaunchOption,
      apply: ({ taskId }, prepromptId) => setTaskPreprompt(taskId, prepromptId),
      inherit: inheritTaskPreprompt,
    }),
  ],
  httpRoutes: {
    [putTaskPreprompt.route]: handlePutTaskPreprompt,
    [deleteTaskPreprompt.route]: handleDeleteTaskPreprompt,
  },
} satisfies ServerPluginDefinition;
