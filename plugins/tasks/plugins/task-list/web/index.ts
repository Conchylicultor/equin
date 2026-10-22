import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Tasks as TasksSlots } from "./slots";
import { ChildCountAction } from "./components/child-count-action";
import { DeleteTaskAction } from "./components/delete-task-action";
import { LaunchAgentAction } from "./components/launch-agent-action";

export { Tasks } from "./slots";
export { TasksListView } from "./components/tasks-list-view";
export {
  useTaskFieldSchema,
  clusterTaskHierarchy,
  buildTreeOptions,
} from "./internal/tasks-data-view";

export default {
  description:
    "Tree view of all tasks rendered in the Tasks pane. Defines Tasks.List/TaskActions/ListActions slots and ships the row actions (delete, child-count, launch-agent).",
  contributions: [
    TasksSlots.TaskActions({
      id: "child-count",
      component: ChildCountAction,
    }),
    TasksSlots.TaskActions({ id: "delete", component: DeleteTaskAction }),
    TasksSlots.TaskActions({
      id: "launch-agent",
      component: LaunchAgentAction,
    }),
  ],
  slots: TasksSlots,
} satisfies PluginDefinition;
