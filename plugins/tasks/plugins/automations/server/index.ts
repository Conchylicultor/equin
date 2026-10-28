import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { automationTaskStatusJob } from "./internal/attention";
import { watchAutomationConfigs } from "./internal/watch";
import { launchDecisionsServed } from "./internal/live";
import { decideLaunchEndpoint, taskApprovalEndpoint } from "../core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { tasksLaunchDecision, tasksOrigin } from "./internal/tables";
import { handleDecideLaunch, handleTaskApproval } from "./internal/routes";
import { slotWatchHandler } from "./internal/slot-watch";

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

export default {
  description:
    "Automations registry: defineAutomation declares something that files a task and launches its agent on its own (file kind) or launches agents on existing tasks a few at a time (launch kind: candidates, launched ONLY when a person approved them — the tasks_ext_launch_decision side-table, one decision per task whatever automation launches it, written by the decide-launch and task-approval endpoints alone — concurrency slots held until a task settles or its agent reports — the automations.slot code watcher on every launched task, fed the outcome report through the watch plugin —, and a maxLaunches batch per turn-on after which it turns itself off), and owns its job (automation.<id>) — its config document (defineAutomationConfig: enabled, push policy, model, excluded sources, trigger — a schedule re-installed live on change, or an event whose bursts settle into one run — and the prompt template), the one-open-task dedupe, the filled prompt, the filing (task + category + tasks_ext_origin row in one transaction) and the armed launch. Serves the automations.launch-decisions.all set, exposes the filing automation and the launch decision to every list whose rows reach a task (the `origin` and `approval` fields), and notifies the bell when an automated task needs its person. The automations.catalog value and the automations.tasks collection (the origin side-table, an automation's history) are the machine half's.",
  contributions: [
    // Which automation filed or launched a task, folded into every list
    // whose rows reach a task (the `origin` field).
    LiveColumns.Expose(tasksOrigin),
    ...launchDecisionsServed.declare,
    // A person's launch decision on a task, folded into every list whose rows
    // reach a task (the `approval` field).
    LiveColumns.Expose(tasksLaunchDecision),
    slotWatchHandler,
    Trigger({
      on: taskStatusChanged,
      do: automationTaskStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  httpRoutes: {
    [decideLaunchEndpoint.route]: handleDecideLaunch,
    [taskApprovalEndpoint.route]: handleTaskApproval,
  },
  register: [automationTaskStatusJob],
  onAllReady: () => {
    watchAutomationConfigs();
  },
} satisfies ServerPluginDefinition;
