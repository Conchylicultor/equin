import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskLaunchServer } from "@plugins/tasks/plugins/launch-options/server";
import { setMandate } from "@plugins/tasks/plugins/tasks-core/server";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { supervisorLaunchOption } from "../core";

export default {
  portable: true,
  description:
    "The Supervisor launch option's server half: a task filed with it states the supervisor mandate (supervisorMandate()) as its own — its conversation an ordinary one with more powers, the tasks it files workers that report. Not inherited: the tasks its agents file are covered by the mandate already (nearest wins).",
  contributions: [
    TaskLaunchServer({
      def: supervisorLaunchOption,
      apply: async ({ taskId }, supervisor) => {
        if (supervisor) await setMandate(taskId, supervisorMandate());
      },
    }),
  ],
} satisfies ServerPluginDefinition;
