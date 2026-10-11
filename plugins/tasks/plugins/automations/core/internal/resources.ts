import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { nullable } from "@plugins/fields/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
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
export const taskOriginShape = defineExtensionShape({
  key: "taskId",
  fields: {
    automationId: textField(),
    sourceKeys: jsonField({ schema: z.array(z.string()), default: [] }),
    filedAt: dateField(),
    role: enumTextField(ORIGIN_ROLES, { default: "filed" }),
    releasedAt: nullable(dateField()),
  },
});
export const AutomationTaskRowSchema = taskOriginShape.schema;
export type AutomationTaskRow = z.infer<typeof AutomationTaskRowSchema>;

/**
 * The tasks automations filed, newest first. One automation's history is
 * `useLive(automationTasks, { where: { automationId } })`; one task's origin is
 * `useLiveRow(automationTasks, taskId)` (`found: false` ⇒ not an automation's).
 *
 * The task list's Automation field reads the whole window (up to `maxLimit`),
 * since it needs an origin for EVERY task row: naming every task id would be
 * O(tasks), while what is bounded here is the set of automated tasks (the
 * `task-tracks` reasoning). Past `maxLimit` rows, the oldest-filed read as
 * filed by a person in the LIST only — the single-task reads stay exact.
 */
export const automationTasks = liveCollection("automations.tasks", {
  row: AutomationTaskRowSchema,
  id: "taskId",
  filterable: { automationId: liveText() },
  sortable: ["filedAt"],
  default: { orderBy: [["filedAt", "desc"]], limit: 50 },
  maxLimit: 2000,
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
 * The launch decisions, newest first: one automation's are
 * `useLive(launchDecisions, { where: { automationId } })`. Bounded by what a
 * person clicked through — a review list, not the task table.
 */
export const launchDecisions = liveCollection("automations.launch-decisions", {
  row: LaunchDecisionRowSchema,
  id: "taskId",
  filterable: { automationId: liveText() },
  sortable: ["decidedAt"],
  default: { orderBy: [["decidedAt", "desc"]], limit: 500 },
  maxLimit: 2000,
});
