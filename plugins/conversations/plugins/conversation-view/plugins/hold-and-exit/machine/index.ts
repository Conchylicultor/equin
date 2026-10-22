import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleHoldAndExit } from "./internal/handle-hold-and-exit";
import { holdAndExit } from "../shared/endpoints";

export default {
  httpRoutes: {
    [holdAndExit.route]: handleHoldAndExit,
  },
} satisfies MachinePluginDefinition;
