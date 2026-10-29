import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskLaunchServer } from "@plugins/tasks/plugins/launch-options/server";
import { setMandate } from "@plugins/tasks/plugins/tasks-core/server";
import { autonomousMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { autonomousLaunchOption } from "../core";

export default {
  portable: true,
  description:
    "The Autonomous launch option's server half: a task filed with it states the autonomous mandate (autonomousMandate()) as its own, so its subtree runs as an autonomous run. Not inherited: the tasks its agents file are covered by the mandate already (nearest wins).",
  contributions: [
    TaskLaunchServer({
      def: autonomousLaunchOption,
      apply: async ({ taskId }, autonomous) => {
        if (autonomous) await setMandate(taskId, autonomousMandate());
      },
    }),
  ],
} satisfies ServerPluginDefinition;
