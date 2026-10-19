import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  agentSessionArgs,
  agentSessionEnv,
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
    "What every app-launched agent starts with, whatever runtime hosts it: the tmux session's allowlisted environment (the env -i wrapper, the -e values it delivers, its PATH and login shell — agentSessionArgs), the fixed CLI settings, the hooks every runtime runs (the compaction hook) and the one merge of the launch's settings fragments.",
} satisfies ServerPluginDefinition;
