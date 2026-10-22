import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { taskAutoStartServed } from "./internal/resource";
import { cancelAutoStartOnDropJob } from "./internal/cancel-on-drop";
import { taskAutoStartArmed } from "./internal/tables-events";

export {
  setTaskAutoStart,
  claimAutoStart,
  getTaskAutoStart,
  listArmedTaskIds,
} from "./internal/mutations";
export {
  taskAutoStartArmed,
  _taskAutoStartArmedTriggers,
} from "./internal/tables-events";
export type { TaskAutoStartArmedPayload } from "./internal/tables-events";

export default {
  portable: true,
  description:
    "Owns the tasks_ext_auto_start side-table via the entity-extensions primitive. CAS mutations for setTaskAutoStart/claimAutoStart, and the tasks.autoStartArmed trigger event whatever launches agents subscribes to.",
  contributions: [
    ...taskAutoStartServed.declare,
    Trigger({
      on: taskStatusChanged,
      do: cancelAutoStartOnDropJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [taskAutoStartArmed, cancelAutoStartOnDropJob],
} satisfies ServerPluginDefinition;
