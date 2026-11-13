import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  SupervisorDoneCount,
  useIsSupervisorRoot,
} from "./components/supervisor-done-count";

export default {
  description:
    "A supervisor's done count (SupervisorDoneCount): how many tasks of its tree are done, however deep, with a ring filled by the done share of the whole tree; hover for done / open / dropped. useIsSupervisorRoot(taskId) tells whether a task states the supervisor mandate. The conversation progress chip draws it in place of its step bar on a supervisor's conversation.",
} satisfies PluginDefinition;
