import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  agentSessionEnv,
  agentSessionLaunch,
} from "./internal/agent-session-env";
export type { AgentSessionEnv } from "./internal/agent-session-env";
export {
  agentLaunchHooks,
  LAUNCH_CLI_SETTINGS,
  mergeLaunchSettings,
} from "./internal/launch-settings";
export type { LaunchHooks } from "./internal/launch-settings";

export default {
  description:
    "What every app-launched agent starts with, whatever runtime hosts it: the agent process's allowlisted environment (the env -i wrapper, the values it delivers, its PATH and login shell — agentSessionLaunch), the fixed CLI settings, the hooks every runtime runs (the compaction hook) and the one merge of the launch's settings fragments.",
} satisfies ServerPluginDefinition;
