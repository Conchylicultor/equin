import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { taskAutoStartServed } from "./internal/resource";
import { disarmAutoStartOnStatusJob } from "./internal/disarm-on-status";
import { taskAutoStartArmed } from "./internal/tables-events";
import { autoStartDisarmSweepWarmup } from "./internal/disarm-sweep";

export {
  setTaskAutoStart,
  claimAutoStart,
  getTaskAutoStart,
  listArmedTaskIds,
  listLaunchableArmedIn,
} from "./internal/mutations";
export {
  taskAutoStartArmed,
  _taskAutoStartArmedTriggers,
} from "./internal/tables-events";
export type { TaskAutoStartArmedPayload } from "./internal/tables-events";

export default {
  description:
    "Owns the tasks_ext_auto_start side-table via the entity-extensions primitive. CAS mutations for setTaskAutoStart/claimAutoStart, and the tasks.autoStartArmed trigger event whatever launches agents subscribes to, and the job and host-scoped boot warm-up that clear the marker of every task whose status decides `disarm` (AUTO_START_DECISIONS: dropped, done, or an agent running).",
  contributions: [
    ...taskAutoStartServed.declare,
    Trigger({
      on: taskStatusChanged,
      do: disarmAutoStartOnStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [
    taskAutoStartArmed,
    disarmAutoStartOnStatusJob,
    autoStartDisarmSweepWarmup,
  ],
} satisfies ServerPluginDefinition;
