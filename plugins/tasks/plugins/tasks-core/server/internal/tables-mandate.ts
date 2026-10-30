import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskMandateShape } from "../../core";
import { _tasks } from "./tables";

// `tasks_ext_mandate`: every task's effective mandate (see `taskMandateShape`).
// Written only by `refreshEffectiveMandates`.
export const tasksMandate = defineExtension(
  _tasks,
  "mandate",
  taskMandateShape,
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksMandateExt = tasksMandate.table;
