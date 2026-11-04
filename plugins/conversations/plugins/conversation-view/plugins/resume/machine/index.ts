import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleResume } from "./internal/handle-resume";
import { handleRetryLaunch } from "./internal/handle-retry-launch";
import {
  resumeConversationEndpoint,
  retryLaunchEndpoint,
} from "../core/endpoints";

export default {
  httpRoutes: {
    [resumeConversationEndpoint.route]: handleResume,
    [retryLaunchEndpoint.route]: handleRetryLaunch,
  },
} satisfies MachinePluginDefinition;
