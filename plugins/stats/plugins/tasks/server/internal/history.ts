import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { TaskHistoryDaySchema, tasksHistory } from "../../shared/values";
import { _taskHistoryDays } from "./rollup-table";

/**
 * One row per UTC day, read off the `task_history_days` rollup (`./rollups.ts`):
 * a task adds 1 to `added` on the day it was created and resolves on one day
 * by its status — `done` at `finished_at` (its first landed push), `dropped`
 * at `dropped_at`, `held` at `held_at` (counted as dropped). The read is the
 * days, never the tasks: it used to aggregate all of `tasks_v` (deriving every
 * task's status, the transitive blocking closure included — 85–150 ms for ~9k
 * tasks) on every task, attempt, conversation or push write.
 */
async function loadHistory() {
  return executeRows(db, {
    label: "stats.tasks.history",
    query: sql`
      SELECT to_char(${_taskHistoryDays.day}, 'YYYY-MM-DD') AS date,
             ${_taskHistoryDays.added} AS added,
             ${_taskHistoryDays.completed} AS completed,
             ${_taskHistoryDays.dropped} AS dropped
        FROM ${_taskHistoryDays}
       ORDER BY ${_taskHistoryDays.day}`,
    row: TaskHistoryDaySchema,
  });
}

export const tasksHistoryServed = serveValue(tasksHistory, {
  source: "db",
  reads: {
    tables: [_taskHistoryDays],
    reason:
      "the whole history is the day rollup's rows (one per day with any task created or resolved); the rollup is on the change feed and rewrites a day only when its numbers move",
  },
  loader: loadHistory,
});
