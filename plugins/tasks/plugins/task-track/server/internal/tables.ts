import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { DEFAULT_TASK_TRACK } from "../../core";
import { taskTrackShape } from "../../core";

// Per-task track. The column defaults to the field's declared default (main),
// so a missing row and a defaulted one read the same (`defineExtension`
// asserts it); `setTaskTrack` keeps only non-main rows, so no existing task
// needs a backfill and no `createTask` call site needs to know tracks exist.
export const tasksTrack = defineExtension(_tasks, "track", taskTrackShape, {
  columns: { track: { default: DEFAULT_TASK_TRACK } },
});
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksTrackExt = tasksTrack.table;
