import { date, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import {
  TASK_HISTORY_DAYS_TABLE,
  TASK_HISTORY_FACTS_TABLE,
} from "@plugins/database/plugins/derived-views/core";

// Drizzle READ handles for the task history's two rollups (`./rollups.ts`).
// In a NON-glob file (never `tables.ts` / `schema.ts`): derived state, created
// imperatively on boot by `prepareRollupTables` from these handles, never a
// migration.

/**
 * Per task: the UTC day it was created, and — once it resolved — the day and
 * the way (`completed` or `dropped`; a held task counts as dropped). Indexed
 * by both days: the day rollup re-aggregates a day by reading its tasks.
 */
export const _taskHistoryFacts = pgTable(
  TASK_HISTORY_FACTS_TABLE,
  {
    taskId: text("task_id").primaryKey(),
    createdDay: date("created_day").notNull(),
    resolvedDay: date("resolved_day"),
    resolution: text("resolution"),
  },
  (t) => [
    index("task_history_facts_created_day_idx").on(t.createdDay),
    index("task_history_facts_resolved_day_idx").on(t.resolvedDay),
  ],
);

/** Per UTC day with any: tasks created, completed and dropped (held included) that day. */
export const _taskHistoryDays = pgTable(TASK_HISTORY_DAYS_TABLE, {
  day: date("day").primaryKey(),
  added: integer("added").notNull(),
  completed: integer("completed").notNull(),
  dropped: integer("dropped").notNull(),
});
