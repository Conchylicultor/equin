import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { automationTaskStatusJob } from "./internal/attention";
import { watchAutomationConfigs } from "./internal/watch";
import {
  automationsCatalogServed,
  automationTasksServed,
  launchDecisionsServed,
} from "./internal/live";
import { decideLaunchEndpoint } from "../core";
import { handleDecideLaunch } from "./internal/routes";

// What an automation's plugin uses: `defineAutomation` declares one (mount it
// in `register`). Readers use the core live values; nothing names an
// automation.
export { defineAutomation } from "./internal/define";
export { automationConfigRegistration } from "./internal/config-registration";
export type { Automation } from "./internal/define";
export type {
  AutomationDetectCtx,
  AutomationLaunchCtx,
  AutomationSpec,
  FileAutomationSpec,
  LaunchAutomationSpec,
  LaunchCandidate,
} from "./internal/registry";
export type { AutomationFiling } from "./internal/origin";
// What a plugin that works WITH automated tasks uses, naming none: which
// automation filed or launched a task, and handing a launched task's slot back
// once its agent is done (e.g. it reported).
export { automationOfTask } from "./internal/origin";
export { releaseLaunchedTask } from "./internal/release";

export default {
  description:
    "Automations registry: defineAutomation declares something that files a task and launches its agent on its own (file kind) or launches agents on existing tasks a few at a time (launch kind: candidates, launched ONLY when a person approved them — the tasks_ext_launch_decision side-table, written by the decide-launch endpoint alone — concurrency slots held until a task settles or releaseLaunchedTask, and a maxLaunches batch per turn-on after which it turns itself off), and owns its job (automation.<id>) — its config document (defineAutomationConfig: enabled, push policy, model, excluded sources, trigger — a schedule re-installed live on change, or an event whose bursts settle into one run — and the prompt template), the one-open-task dedupe, the filled prompt, the filing (task + category + tasks_ext_origin row in one transaction) and the armed launch. Serves the automations.catalog value, the automations.tasks collection (the origin side-table) and the automations.launch-decisions collection, and notifies the bell when an automated task needs its person.",
  contributions: [
    ...automationsCatalogServed.declare,
    ...automationTasksServed.declare,
    ...launchDecisionsServed.declare,
    Trigger({
      on: taskStatusChanged,
      do: automationTaskStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  httpRoutes: {
    [decideLaunchEndpoint.route]: handleDecideLaunch,
  },
  register: [automationTaskStatusJob],
  onAllReady: () => {
    watchAutomationConfigs();
  },
} satisfies ServerPluginDefinition;
