import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleResume } from "./internal/handle-resume";
import { resumeConversationEndpoint } from "../core/endpoints";

export default {
  httpRoutes: {
    [resumeConversationEndpoint.route]: handleResume,
  },
} satisfies MachinePluginDefinition;
