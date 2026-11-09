import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { stopBackstopJob } from "./internal/backstop-job";

export { stopGateHookEntry } from "./internal/hook-entry";

export default {
  description:
    "The stop-gate hook, desktop-only half: stopGateHookEntry — the Stop hook entry an agent launch merges into its settings, running the hook script beside this code by absolute path (checked on disk, so a launch never installs a hook that cannot run) — and the stop-gate.backstop job: the same decision asked again once the agent has stopped (the hook fails open), one reminder turn with the gates' reason, then a notification.",
  contributions: [
    Trigger({
      on: conversationStatusChanged,
      do: stopBackstopJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [stopBackstopJob],
} satisfies MachinePluginDefinition;
