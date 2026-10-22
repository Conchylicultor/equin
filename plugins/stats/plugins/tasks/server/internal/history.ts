import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { tasksView } from "@plugins/tasks/plugins/tasks-core/server";
import { TaskHistoryDaySchema, tasksHistory } from "../../shared/values";

/**
 * Aggregated per UTC day in SQL. A task adds 1 to `added` on the day it was
 * created; it resolves on one day by its status: `done` at `finished_at` (the
 * first completed push — the view's `finished_at` is also `dropped_at` for a
 * dropped task, so the status picks the column), `dropped` at `dropped_at`,
 * `held` at `held_at` (counted as dropped). A resolved status with no
 * timestamp stays active, as the old endpoints counted it.
 */
async function loadHistory() {
  return executeRows(db, {
    label: "stats.tasks.history",
    query: sql`
      SELECT date, SUM(added)::int AS added, SUM(completed)::int AS completed,
             SUM(dropped)::int AS dropped
        FROM (
          SELECT created_at AS at, 1 AS added, 0 AS completed, 0 AS dropped
            FROM ${tasksView}
          UNION ALL
          SELECT finished_at, 0, 1, 0
            FROM ${tasksView} WHERE status = 'done' AND finished_at IS NOT NULL
          UNION ALL
          SELECT dropped_at, 0, 0, 1
            FROM ${tasksView} WHERE status = 'dropped' AND dropped_at IS NOT NULL
          UNION ALL
          SELECT held_at, 0, 0, 1
            FROM ${tasksView} WHERE status = 'held' AND held_at IS NOT NULL
        ) events
        CROSS JOIN LATERAL (
          SELECT to_char(events.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
        ) d
       GROUP BY date
       ORDER BY date`,
    row: TaskHistoryDaySchema,
  });
}

export const tasksHistoryServed = serveValue(tasksHistory, {
  source: "db",
  reads: {
    tables: [tasksView],
    reason:
      "the history aggregates every task's created / resolved day over tasks_v's derived status, so a write to any task, attempt or push row may move any day",
  },
  unbounded: {
    reason:
      "one row per UTC day since the first task (a few hundred for a year of use), aggregated in SQL — never one row per task",
  },
  throttleMs: 1000,
  loader: loadHistory,
});
