import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleLaunchTask } from "./internal/handle-launch-task";
import { launchTask } from "../core/endpoints";

export default {
  description:
    "Nested tasks, desktop-only half: the launch route (file a task with its launch options and start its agent now), which spawns Claude Code in a checkout of this repo.",
  httpRoutes: {
    [launchTask.route]: handleLaunchTask,
  },
} satisfies MachinePluginDefinition;
