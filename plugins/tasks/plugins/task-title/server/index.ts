import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { tasksShortTitle } from "./internal/tables";

export {
  scheduleTaskTitleUpdate,
  TaskTitleGenerator,
} from "./internal/generator";
export type { TaskTitleGeneratorImpl } from "./internal/generator";
export { tasksShortTitle } from "./internal/tables";

export default {
  description:
    "Task titles, every host's half: the tasks_ext_short_title side-table (a ≤3-word short title per task, current while its sourceTitle equals the task's title) exposed to every list whose rows reach a task (LiveColumns.Expose), the synthesised fallback title a task is filed with, and scheduleTaskTitleUpdate over the TaskTitleGenerator host service — which upgrades that fallback in the background where a model is available (machine/).",
  contributions: [
    // The short title, folded into every list whose rows reach a task.
    LiveColumns.Expose(tasksShortTitle),
  ],
} satisfies ServerPluginDefinition;
