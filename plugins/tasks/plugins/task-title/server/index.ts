import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { taskShortTitlesServed } from "./internal/short-title-resource";

export {
  scheduleTaskTitleUpdate,
  TaskTitleGenerator,
} from "./internal/generator";
export type { TaskTitleGeneratorImpl } from "./internal/generator";
export { tasksShortTitle } from "./internal/tables";

export default {
  description:
    "Task titles, every host's half: the tasks_ext_short_title side-table (a ≤3-word short title per task, current while its sourceTitle equals the task's title) served as the task-short-titles collection, the synthesised fallback title a task is filed with, and scheduleTaskTitleUpdate over the TaskTitleGenerator host service — which upgrades that fallback in the background where a model is available (machine/).",
  portable: true,
  contributions: [...taskShortTitlesServed.declare],
} satisfies ServerPluginDefinition;
