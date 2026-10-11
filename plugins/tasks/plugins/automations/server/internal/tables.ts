import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { launchDecisionShape, taskOriginShape } from "../../core";

// Where a task came from: a row ⇔ an automation filed or launched it (see the
// shape). The index serves the reads keyed by automation: the open-task dedupe,
// the occupied-slot count and one automation's history window. `role` defaults
// to `filed` in the DB, so every row written before launches existed reads as
// the filing it was.
export const tasksOrigin = defineExtension(_tasks, "origin", taskOriginShape, {
  columns: { role: { default: "filed" } },
  indexes: (t, b) => [
    b.index("automation_filed").on(t.automationId, t.filedAt),
  ],
});
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksOriginExt = tasksOrigin.table;

// What a person decided about launching a task (see the shape): the approved
// set a launch-kind automation draws from, keyed by automation.
export const tasksLaunchDecision = defineExtension(
  _tasks,
  "launch_decision",
  launchDecisionShape,
  {
    indexes: (t, b) => [
      b.index("automation_decision").on(t.automationId, t.decision),
    ],
  },
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksLaunchDecisionExt = tasksLaunchDecision.table;

// One row per launch-kind automation: its current (or last) batch — opened
// when it is turned on, closed when it is turned off. `maxLaunches` counts the
// tasks it launched since `startedAt` while `endedAt` is null.
export const _automationLaunchBatches = pgTable("automation_launch_batches", {
  automationId: text("automation_id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
