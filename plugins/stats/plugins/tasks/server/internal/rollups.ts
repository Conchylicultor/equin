import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import {
  _taskAttemptFacts,
  _tasks,
  taskDerived,
} from "@plugins/tasks/plugins/tasks-core/server";
import { _taskHistoryDays, _taskHistoryFacts } from "./rollup-table";

// Stats → Tasks' history as two trigger-maintained rollups (derived-tables),
// so the card reads one row per day and a task write re-aggregates only the
// task and the days it names — never every task.
//
//   tasks ─┐
//          ├─► task_history_facts (per task) ─► task_history_days (per day, fed)
//   task_attempt_facts ─┘
//
// The per-task layer derives a task's outcome from `taskDerived` — the rule
// `tasks_v.status` / `finished_at` are — over the task's own columns and its
// STORED attempt facts (`task_attempt_facts`, itself a rollup: a conversation
// or push write reaches it only when it moved the task's facts). Unlike
// `tasks_v`, it never evaluates the transitive blocking closure: blocking only
// splits the unresolved statuses (`blocked`, `in_progress_blocked`) and never
// decides done / dropped / held, which are ranked above it — so it, and
// `hasWaiting` (which only splits `need_action` from `in_progress`), are read
// as false here. `hasAttempt` only splits `attempted` from `new`: false too.

/** Drizzle SQL as plain text: every parameter inlined (a rollup's select has none). */
function text(query: SQL): string {
  const rendered = new PgDialect().sqlToQuery(query.inlineParams());
  if (rendered.params.length > 0) {
    throw new Error(
      `stats/tasks rollups: ${rendered.params.length} parameter(s) could not be inlined`,
    );
  }
  return rendered.sql;
}

const outcome = taskDerived({
  heldAt: _tasks.heldAt,
  droppedAt: _tasks.droppedAt,
  hasAttempt: sql`false`,
  hasCompleted: sql`COALESCE(${_taskAttemptFacts.hasCompleted}, false)`,
  hasActive: sql`COALESCE(${_taskAttemptFacts.hasActive}, false)`,
  hasWaiting: sql`false`,
  hasBlockingDep: sql`false`,
  minPushAt: _taskAttemptFacts.minPushAt,
});

/** A task's outcome: its derived status, finish instant and the two resolve stamps. */
const outcomeColumns = text(sql`
  ${_tasks.id} AS task_id,
  ${_tasks.createdAt} AS created_at,
  ${outcome.status} AS status,
  ${outcome.finishedAt} AS finished_at,
  ${_tasks.droppedAt} AS dropped_at,
  ${_tasks.heldAt} AS held_at
  FROM ${_tasks}
  LEFT JOIN ${_taskAttemptFacts} ON ${_taskAttemptFacts.hostId} = ${_tasks.id}`);

const taskIdColumn = text(sql`${_tasks.id}`);

/**
 * Per task: created day, and the day and way it resolved — `completed` (status
 * `done`) at its finish (its first landed push), `dropped` at `dropped_at`,
 * or `held` (counted as dropped) at `held_at`. Days are UTC.
 */
export const taskHistoryFacts = defineRollup({
  table: _taskHistoryFacts,
  key: _taskHistoryFacts.taskId,
  select: (scope) => `
    SELECT o.task_id,
           (o.created_at AT TIME ZONE 'UTC')::date AS created_day,
           (CASE o.status WHEN 'done' THEN o.finished_at
                          WHEN 'dropped' THEN o.dropped_at
                          WHEN 'held' THEN o.held_at END
             AT TIME ZONE 'UTC')::date AS resolved_day,
           CASE o.status WHEN 'done' THEN 'completed'
                         WHEN 'dropped' THEN 'dropped'
                         WHEN 'held' THEN 'dropped' END AS resolution
      FROM (SELECT ${outcomeColumns} WHERE ${scope(taskIdColumn)}) AS o`,
  sources: [
    {
      table: _tasks,
      carry: _tasks.id,
      reads: [_tasks.createdAt, _tasks.heldAt, _tasks.droppedAt],
    },
    {
      table: _taskAttemptFacts,
      carry: _taskAttemptFacts.hostId,
      reads: [
        _taskAttemptFacts.hasCompleted,
        _taskAttemptFacts.hasActive,
        _taskAttemptFacts.minPushAt,
      ],
    },
  ],
});

/**
 * Per UTC day: tasks created, completed and dropped that day. A task names
 * two days (created, resolved), so its facts row carries both: a write
 * re-aggregates the old and new day of each, reading those days' tasks by
 * the two day indexes. On the change feed: the card's reader hears of a day
 * exactly when its numbers changed.
 */
export const taskHistoryDays = defineRollup({
  table: _taskHistoryDays,
  key: _taskHistoryDays.day,
  select: (scope) => `
    SELECT e.day, sum(e.added)::int AS added,
           sum(e.completed)::int AS completed, sum(e.dropped)::int AS dropped
      FROM (SELECT f.created_day AS day, 1 AS added, 0 AS completed, 0 AS dropped
              FROM task_history_facts AS f
             WHERE ${scope("f.created_day")}
            UNION ALL
            SELECT f.resolved_day, 0,
                   (f.resolution = 'completed')::int,
                   (f.resolution = 'dropped')::int
              FROM task_history_facts AS f
             WHERE f.resolved_day IS NOT NULL AND ${scope("f.resolved_day")}) AS e
     GROUP BY e.day`,
  sources: [
    {
      table: _taskHistoryFacts,
      carry: [_taskHistoryFacts.createdDay, _taskHistoryFacts.resolvedDay],
      reads: [_taskHistoryFacts.resolution],
    },
  ],
  fed: true,
});
