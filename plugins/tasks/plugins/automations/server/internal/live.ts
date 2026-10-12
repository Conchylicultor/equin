import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  automationOrigins,
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
import { tasksLaunchDecision, tasksOrigin } from "./tables";

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
 * The catalog, pushed. External: the declarations are process state, the
 * installed schedule and the concurrency move when an automation's config
 * changes, and the DB-derived fields (`openTaskId`, `runningTaskIds`,
 * `launchedInBatch`, `approvedCount`) move only when an automation files,
 * launches or releases a task, one of its tasks changes status, a batch opens
 * or closes, or a person decides on a launch — each says so (`notify`). Bounded by the declared set.
 */
export const automationsCatalogServed = serveValue(automationsCatalog, {
  source: "external",
  changes: "notified",
  loader: loadCatalog,
  throttleMs: 1000,
});

// Served from the extension handle: `taskId` is the `parent_id` PK, the
// projection is exactly the row schema. Filing a task is a window entry;
// a task's deletion cascades its row away (an exit).
export const automationTasksServed = serveCollection(automationTasks, {
  from: tasksOrigin,
});

// The same rows as the whole set, projected to `{ taskId, automationId }`:
// filing a task is an entrant (one refill + one `orderOf`), its deletion an
// exit with no load, and a write to a column the set does not project
// (`releasedAt`, `sourceKeys`) loads nothing.
export const automationOriginsServed = serveCollection(automationOrigins, {
  from: tasksOrigin,
});

// Served from the extension handle, like the origin rows: a decision is an
// entrant of the whole set, a changed one a one-row refill, a cleared one an
// exit.
export const launchDecisionsServed = serveCollection(launchDecisions, {
  from: tasksLaunchDecision,
});
