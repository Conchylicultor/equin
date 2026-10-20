import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Tasks } from "@plugins/tasks/plugins/task-list/web";
import { QueuedChipAction } from "./components/queued-chip-action";

export type { TaskAutoStartRow } from "../core";
export { useTaskAutoStart } from "./hooks";

export default {
  description:
    "Owns the tasks_ext_auto_start side-table via the entity-extensions primitive; the model picker over it is the launch-option sub-plugin.",
  contributions: [
    Tasks.TaskActions({ id: "queued-chip", component: QueuedChipAction }),
  ],
} satisfies PluginDefinition;
