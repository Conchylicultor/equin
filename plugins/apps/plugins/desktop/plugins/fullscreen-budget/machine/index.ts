import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { onRunTerminal } from "@plugins/build/machine";
import { fullscreenBudgetJob } from "./internal/budget-job";
import {
  measureLatestDeployWarmup,
  onBuildTerminal,
} from "./internal/after-build";

export default {
  description:
    "The desktop.fullscreen-budget job: after each of main's successful builds, measures the elements the desktop ↔ full screen switch restyles (enter and exit, one window and four, on the demo's seeded data) and files an interaction-budget report naming the commit range when a case is over budget.",
  register: [fullscreenBudgetJob, measureLatestDeployWarmup],
  onReady: async () => {
    // Main only: the guard is about what main serves. A worktree runs the
    // script on demand.
    if (!isMain()) return;
    await onRunTerminal((runId) => {
      void runTracked("fullscreen-budget:after-build", () =>
        onBuildTerminal(runId),
      );
    });
  },
} satisfies MachinePluginDefinition;
