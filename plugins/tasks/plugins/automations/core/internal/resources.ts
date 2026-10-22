import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { nullable } from "@plugins/fields/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { AutomationEntrySchema } from "./entry";
import { LAUNCH_DECISIONS, ORIGIN_ROLES } from "./settings";

/**
 * Every registered automation. External and bounded by the declared set (the
 * process holds the registry); pushed when an automation files or launches a
 * task, releases one, or one of its tasks changes status, since `openTaskId` /
 * `runningTaskIds` move then.
 */
export const automationsCatalog = liveValue("automations.catalog", {
  schema: z.array(AutomationEntrySchema),
  // Served by the machine half: the automations it lists are config-bound
  // (until the config split), so a reader under an in-browser server gets
  // `unavailable`.
  needsMachine: { feature: "Automations" },
});

// Where a task came from: one row per task an automation filed or launched, in
// the `tasks_ext_origin` side-table. A row is the proof; a task with none was
// filed and started by a person (or an agent acting for one). `role` says what
// the automation did (`ORIGIN_ROLES`): `filed` the task (and launched it), or
// only `launched` a task someone else filed. `sourceKeys` are the sources a
// filing covered (the updater ids a dependency upgrade batched; `[]` for a
// launch); `filedAt` is when it was filed or launched — for a task adopted from
// before origins were recorded, the task's own creation time. `releasedAt`
// (launched rows only) is when the task gave its slot back
// (`releaseLaunchedTask`, e.g. its agent reported); `null` while it holds one.
//
// It EXPOSES the automation to every list whose rows reach a task (`exposes` —
// the task list), under the id `origin` (`as`: what saved views name): the
// automation that filed or launched it, NULL for a task with no row (the
// field declares no default) — by hand, the "None" bucket. Its options are
// the live catalog's (presented by this plugin's web half). No list is named
// here.
export const taskOriginShape = defineExtensionShape({
  key: "taskId",
  fields: {
    automationId: textField({ label: "Automation" }),
    sourceKeys: jsonField({ schema: z.array(z.string()), default: [] }),
    filedAt: dateField(),
    role: enumTextField(ORIGIN_ROLES, { default: "filed" }),
    releasedAt: nullable(dateField()),
  },
  exposes: {
    parent: tasksEntityRef,
    name: "origin",
    fields: { automationId: { as: "origin" } },
  },
});
export const AutomationTaskRowSchema = taskOriginShape.schema;
export type AutomationTaskRow = z.infer<typeof AutomationTaskRowSchema>;

/**
 * The tasks automations filed, newest first — an automation's HISTORY:
 * `useLive(automationTasks, { where: { automationId } })`; one task's origin is
 * `useLiveRow(automationTasks, taskId)` (`found: false` ⇒ not an automation's).
 * A list of tasks reads the exposed `origin` field instead (see
 * `taskOriginShape`), never this window as a set.
 */
export const automationTasks = liveCollection("automations.tasks", {
  from: taskOriginShape,
  pick: ["automationId"],
  id: "taskId",
  sortable: ["filedAt"],
  default: { orderBy: [["filedAt", "desc"]], limit: 50 },
  maxLimit: 2000,
  // Served by the machine half, like the catalog it is a history of: the
  // automations are the computer's (their registry and jobs), so a reader
  // under an in-browser server gets `unavailable`.
  needsMachine: { feature: "Automations" },
});

// What a person decided about launching a task with a launch-kind automation:
// one row per decided task, in the `tasks_ext_launch_decision` side-table,
// written ONLY by the person's click (`decideLaunchEndpoint`). `approved` ⇒
// that automation may launch it; `excluded` ⇒ it is not proposed again until
// the row is cleared. No row ⇒ undecided, never launched.
export const launchDecisionShape = defineExtensionShape({
  key: "taskId",
  fields: {
    automationId: textField(),
    decision: enumTextField(LAUNCH_DECISIONS),
    decidedAt: dateField(),
  },
});
export const LaunchDecisionRowSchema = launchDecisionShape.schema;
export type LaunchDecisionRow = z.infer<typeof LaunchDecisionRowSchema>;

/**
 * Every launch decision, as the WHOLE ordered set (`all`): a launch list joins
 * the decisions to every task it shows (`useLive(launchDecisions, { select })`
 * keeping its own automation's), so its reader holds them entire — a decided
 * task never reads as undecided past a window's edge.
 *
 * The key is `automations.launch-decisions.all`, not the old window's
 * `automations.launch-decisions`: no bundle ever declared this key with another
 * contract, so a tab on an older one gets `unknown-key` (a `skew` verdict) and
 * never parses these rows.
 */
export const launchDecisions = liveCollection(
  "automations.launch-decisions.all",
  {
    from: launchDecisionShape,
    id: "taskId",
    all: {
      orderBy: [["taskId", "asc"]],
      unbounded: {
        reason:
          "at most one row per task (a person's call on launching it), and a launch list joins them to every task it shows",
      },
    },
  },
);
