import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleDropDependents } from "./internal/handle-drop-dependents";
import { dropDependents } from "../shared/endpoints";

export default {
  httpRoutes: {
    [dropDependents.route]: handleDropDependents,
  },
} satisfies MachinePluginDefinition;
