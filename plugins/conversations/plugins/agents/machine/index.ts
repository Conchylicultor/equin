import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { launchAgent } from "../core";
import { handleLaunch } from "./internal/handle-launch";

export default {
  description:
    "Agents, desktop-only half: the launch route (file the launch's task and start the agent's conversation), which spawns Claude Code.",
  httpRoutes: {
    [launchAgent.route]: handleLaunch,
  },
} satisfies MachinePluginDefinition;
