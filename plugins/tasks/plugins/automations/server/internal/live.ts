import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  automationsCatalog,
  automationTasks,
  launchDecisions,
  cadenceWords,
  PUSH_POLICY_VARIABLE,
  type AutomationEntry,
  type AutomationSettings,
  type AutomationTrigger,
} from "../../core";
import { getConfig } from "@plugins/config_v2/server";
import {
  occupiedSlotTaskIdsByAutomation,
  openAutomationTaskIds,
} from "./origin";
import { pendingApprovalCounts } from "./decisions";
import { launchedInOpenBatches } from "./launch-batch";
import { registeredAutomations, type AutomationSpec } from "./registry";
import { automationCron, automationSettings } from "./settings";
import { tasksView } from "@plugins/tasks/plugins/tasks-core/server";
import {
  _automationLaunchBatches,
  tasksLaunchDecision,
  tasksOrigin,
} from "./tables";

function triggerOf(
  spec: AutomationSpec,
  jobName: string,
  settings: AutomationSettings,
): AutomationTrigger {
  const { cron, error } = automationCron(spec);
  const eventLabel =
    "eventLabel" in spec.triggers ? spec.triggers.eventLabel : null;
  return {
    kinds: [...spec.triggers.kinds],
    current: settings.trigger,
    words:
      settings.trigger === "event"
        ? (eventLabel ?? "On its event")
        : cadenceWords(settings.schedule),
    eventLabel,
    jobName,
    cron,
    scheduleError: error,
  };
}

async function loadCatalog(): Promise<AutomationEntry[]> {
  const [open, running, inBatch, approved] = await Promise.all([
    openAutomationTaskIds(),
    occupiedSlotTaskIdsByAutomation(),
    launchedInOpenBatches(),
    pendingApprovalCounts(),
  ]);
  return registeredAutomations().map(({ spec, jobName }) => {
    const settings = automationSettings(spec);
    const common = {
      id: spec.id,
      label: spec.label,
      icon: spec.icon,
      description: spec.description,
      enabled: settings.enabled,
      trigger: triggerOf(spec, jobName, settings),
      sources: spec.sources?.() ?? [],
      promptVariables: [...spec.promptVariables, PUSH_POLICY_VARIABLE],
    };
    if (spec.kind === "launch") {
      const config = getConfig(spec.config);
      return {
        ...common,
        kind: "launch" as const,
        concurrency: config.concurrency,
        runningTaskIds: running.get(spec.id) ?? [],
        maxLaunches: config.maxLaunches,
        launchedInBatch: inBatch.get(spec.id) ?? 0,
        approvedCount: approved.get(spec.id) ?? 0,
      };
    }
    return {
      ...common,
      kind: "file" as const,
      categoryId: spec.categoryId,
      openTaskId: open.get(spec.id) ?? null,
    };
  });
}

/**
 * The catalog, pushed. External: the declarations are process state, and the
 * installed schedule and the concurrency move when an automation's config
 * changes (`notify` in watch.ts). The DB-derived fields (`openTaskId`,
 * `runningTaskIds`, `launchedInBatch`, `approvedCount`) are declared `reads`,
 * so the change feed recomputes the catalog on any write to them — `tasks_v`
 * as a view (the loader filters on its derived `status`), reached through its
 * base tables. Bounded by the declared set.
 */
export const automationsCatalogServed = serveValue(automationsCatalog, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [
      tasksView,
      tasksOrigin.table,
      tasksLaunchDecision.table,
      _automationLaunchBatches,
    ],
    reason:
      "The catalog is one singleton listing every automation: its open task, occupied slots, launches in the open batch and approved count join the origin, launch-decision and launch-batch tables over each task's derived status, so a write to any row of them may change any entry.",
  },
  loader: loadCatalog,
  throttleMs: 1000,
});

// Served from the extension handle: `taskId` is the `parent_id` PK, the
// projection is exactly the row schema. Filing a task is a window entry;
// a task's deletion cascades its row away (an exit).
export const automationTasksServed = serveCollection(automationTasks, {
  from: tasksOrigin,
});

// Served from the extension handle, like the origin rows: a decision is an
// entrant of the whole set, a changed one a one-row refill, a cleared one an
// exit.
export const launchDecisionsServed = serveCollection(launchDecisions, {
  from: tasksLaunchDecision,
});
