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
    // ONE pass over tasks_v: each task row fans out into its (up to three)
    // events through a VALUES list. The view derives every task's status
    // from its attempts, pushes and conversations (~100 ms for ~9k tasks); a
    // UNION of four selects over it evaluated it four times (0.5–0.7 s,
    // report-1795095247-rouu7t) on every task, attempt or push write.
    query: sql`
      SELECT date, SUM(added)::int AS added, SUM(completed)::int AS completed,
             SUM(dropped)::int AS dropped
        FROM ${tasksView} t
        CROSS JOIN LATERAL (VALUES
          (t.created_at, 1, 0, 0),
          (CASE WHEN t.status = 'done' THEN t.finished_at END, 0, 1, 0),
          (CASE WHEN t.status = 'dropped' THEN t.dropped_at
                WHEN t.status = 'held' THEN t.held_at END, 0, 0, 1)
        ) AS e(at, added, completed, dropped)
        CROSS JOIN LATERAL (
          SELECT to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
        ) d
       WHERE e.at IS NOT NULL
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
  throttleMs: 1000,
  loader: loadHistory,
});
