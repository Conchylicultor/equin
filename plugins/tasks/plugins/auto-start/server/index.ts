import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { taskAutoStartServed } from "./internal/resource";
import { cancelAutoStartOnDropJob } from "./internal/cancel-on-drop";

export {
  setTaskAutoStart,
  claimAutoStart,
  getTaskAutoStart,
  listArmedTaskIds,
} from "./internal/mutations";

export default {
  portable: true,
  description:
    "Owns the tasks_ext_auto_start side-table via the entity-extensions primitive. CAS mutations for setTaskAutoStart/claimAutoStart.",
  contributions: [
    ...taskAutoStartServed.declare,
    Trigger({
      on: taskStatusChanged,
      do: cancelAutoStartOnDropJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [cancelAutoStartOnDropJob],
} satisfies ServerPluginDefinition;
