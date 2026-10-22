import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleExit } from "./internal/handle-exit";
import { exitConversation } from "../core/endpoints";

export default {
  httpRoutes: {
    [exitConversation.route]: handleExit,
  },
} satisfies MachinePluginDefinition;
