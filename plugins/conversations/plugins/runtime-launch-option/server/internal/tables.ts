import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskRuntimeShape } from "../../shared/schemas";

// Per-task chosen runtime. Absent = the configured default.
export const tasksRuntime = defineExtension(
  _tasks,
  "runtime",
  taskRuntimeShape,
);
export const _tasksRuntimeExt = tasksRuntime.table;
