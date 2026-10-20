import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskAutoStartShape } from "../../core";

// Per-task auto-start marker: presence = armed. See the shape for why the model
// column is decoded through the tolerant schema.
export const tasksAutoStart = defineExtension(
  _tasks,
  "auto_start",
  taskAutoStartShape,
);
export const _tasksAutoStartExt = tasksAutoStart.table;
