import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  agentSessionEnv,
  agentSessionLaunch,
} from "./internal/agent-session-env";
export type { AgentSessionEnv } from "./internal/agent-session-env";
export {
  agentLaunchPolicy,
  LAUNCH_CLI_SETTINGS,
  mergeLaunchSettings,
} from "./internal/launch-settings";
export type { LaunchHooks, LaunchPolicy } from "./internal/launch-settings";

export default {
  description:
    "What every app-launched agent starts with, whatever runtime hosts it: the agent process's allowlisted environment (the env -i wrapper, the values it delivers, its PATH and login shell — agentSessionLaunch), the fixed CLI settings, the policy every runtime launches with (the agent-policy guards and deny rules, the compaction hook) and the one merge of the launch's settings fragments.",
} satisfies ServerPluginDefinition;
