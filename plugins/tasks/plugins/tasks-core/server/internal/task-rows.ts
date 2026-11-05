import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  aggregate,
  childrenJoin,
  closureJoin,
  expr,
  type ChildRefs,
  type NestedRollupJoin,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { materializeJoin } from "@plugins/network/plugins/live/plugins/query-resource/server";
import type {
  ServeAllCollectionOptions,
  ServeCollectionOptions,
} from "@plugins/network/plugins/live/server";
import { TaskStatusSchema, type TaskListItem } from "../../core";
import {
  depIsBlocking,
  taskAttemptAggregates,
  taskDerived,
  type AttemptFacts,
  type SqlOperand,
} from "./derived";
import { attemptConvAgg, attemptPushAgg } from "./rollup-spec";
import {
  _attemptPushAgg,
  _taskAttemptFacts,
  _taskBlocking,
  _taskDependencyList,
} from "./rollup-table";
import { _attempts, _taskDependencies, _tasks } from "./tables";

// How `taskRows` (core: the whole ordered set of tasks, key `tasks`) binds to
// the database — the ONE spelling both the served collection
// (`./resources.ts`) and the tests (`./tree-oracle.test.ts`, which compiles it
// against a throwaway database; `./all-parity.test.ts`, which holds it equal
// to `tasks_v`) read, so neither can drift from what ships.
//
// It reads the BASE table and three MATERIALIZED joins (query-resource's
// `materializeJoin`: each a derived-tables rollup keyed by the task id, on the
// change feed), never a view (A8). Every row field but the four derived ones
// is a column of `tasks` by name; the derived ones are `taskDerived`
// (./derived.ts) — the definition `tasks_v` interpolates — over:
//
//  - `att` (`task_attempt_facts`): the task's attempts (children on
//    `attempts.task_id`), each with its two rollup rows — the per-task facts
//    `taskAttemptAggregates` names. Maintained by attempt writes and by the
//    attempt rollups' own rows (a conversation / push write moves its task's
//    facts only when it moved the attempt's aggregate).
//  - `deps` (`task_dependency_list`): the task's own edges (children on
//    `task_dependencies.task_id`): `dependencies`, the prerequisite ids in
//    creation order.
//  - `blocking` (`task_prerequisite_blocking`): the transitive prerequisites (a closure
//    over `task_dependencies`, child `task_id` → parent `depends_on_task_id`),
//    each ancestor with its STORED attempt facts (`att`'s table):
//    `depIsBlocking` over every one. A prerequisite's change re-aggregates
//    every task that depends on it, however deep (the closure's key
//    expansion).
//
// Because they are stored, a WINDOW over tasks reads them too: `status`
// filters, sorts and groups like a column, and a write anywhere in a task's
// closure reaches the window as a write to its side rows.

/** The conversation / push rollup rows of one attempt, as a children join nests them. */
const conv = {
  kind: "rollup",
  alias: "conv",
  rollup: attemptConvAgg,
  on: _attempts.id,
} as const satisfies NestedRollupJoin;
const push = {
  kind: "rollup",
  alias: "push",
  rollup: attemptPushAgg,
  on: _attempts.id,
} as const satisfies NestedRollupJoin;

type AttemptRefs = ChildRefs<
  "att",
  typeof _attempts,
  readonly [typeof conv, typeof push]
>;

const attemptFacts = (c: AttemptRefs): AttemptFacts => ({
  hasConv: c.conv.hasConv,
  hasLiveConv: c.conv.hasLiveConv,
  hasOpenConv: c.conv.hasOpenConv,
  maxEndedAt: c.conv.maxEndedAt,
  hasPush: c.push.hasPush,
  hasDelivery: c.push.hasDelivery,
  hasWorkingConv: c.conv.hasWorkingConv,
  minPushAt: c.push.minPushAt,
});

/** A per-task flag over the task's attempts: `false` for a task with none. */
const flag = (expression: SQL) =>
  aggregate(expression, {
    decoder: Boolean,
    sqlType: "boolean",
    notNull: true,
    ifNone: sql`false`,
  });

/** A task's attempt facts, stored per task (`task_attempt_facts`). */
export const taskAttemptFacts = materializeJoin(
  childrenJoin({
    alias: "att",
    table: _attempts,
    fk: _attempts.taskId,
    rollups: [conv, push],
    aggregates: (c) => {
      const a = taskAttemptAggregates({
        ...attemptFacts(c),
        hasWaitingConv: c.conv.hasWaitingConv,
      });
      return {
        hasAttempt: flag(a.hasAttempt),
        hasCompleted: flag(a.hasCompleted),
        hasActive: flag(a.hasActive),
        hasWaiting: flag(a.hasWaiting),
        minPushAt: aggregate(a.minPushAt, {
          decoder: _attemptPushAgg.minPushAt,
          sqlType: "timestamp with time zone",
        }),
      };
    },
  }),
  { host: _tasks, table: _taskAttemptFacts },
);

/** A task's prerequisite ids in creation order, stored per task (`task_dependency_list`). */
export const taskDependencyList = materializeJoin(
  childrenJoin({
    alias: "deps",
    table: _taskDependencies,
    fk: _taskDependencies.taskId,
    aggregates: (c) => ({
      list: aggregate(
        sql`array_agg(${c.deps.dependsOnTaskId} ORDER BY ${c.deps.createdAt})`,
        {
          decoder: parsed(z.array(z.string()), "tasks.dependencies"),
          sqlType: "text[]",
          notNull: true,
          ifNone: sql`ARRAY[]::text[]`,
        },
      ),
    }),
  }),
  { host: _tasks, table: _taskDependencyList },
);

// Each transitive prerequisite's STORED facts: a task without a facts row has
// no attempt, so it is neither completed nor active.
const ancestorFacts = {
  kind: "rollup",
  alias: "att",
  rollup: taskAttemptFacts.rollup,
  on: _tasks.id,
} as const satisfies NestedRollupJoin;

/** Whether a transitive prerequisite still blocks the task, stored per task (`task_prerequisite_blocking`). */
export const taskBlocking = materializeJoin(
  closureJoin({
    alias: "blocking",
    edges: _taskDependencies,
    child: _taskDependencies.taskId,
    parent: _taskDependencies.dependsOnTaskId,
    nodes: _tasks,
    ancestorJoins: [ancestorFacts],
    aggregates: (c) => ({
      has: flag(
        sql`bool_or(${depIsBlocking({
          droppedAt: c.anc.droppedAt,
          heldAt: c.anc.heldAt,
          hasCompleted: sql`COALESCE(${c.att.hasCompleted}, false)`,
          hasActive: sql`COALESCE(${c.att.hasActive}, false)`,
        })})`,
      ),
    }),
  }),
  { host: _tasks, table: _taskBlocking },
);

/** The materialized joins' rollups, readers last (`TASK_ROLLUPS`). */
export const TASK_MATERIALIZED_ROLLUPS = [
  taskAttemptFacts.rollup,
  taskDependencyList.rollup,
  taskBlocking.rollup,
] as const;

const joins = [
  taskAttemptFacts.join(),
  taskDependencyList.join(),
  taskBlocking.join(),
] as const;

/** A task's facts, as the compile reads them off `j`. */
interface TaskRefs {
  base: { heldAt: SqlOperand; droppedAt: SqlOperand };
  att: {
    hasAttempt: SqlOperand;
    hasCompleted: SqlOperand;
    hasActive: SqlOperand;
    hasWaiting: SqlOperand;
    minPushAt: SqlOperand;
  };
  blocking: { has: SqlOperand };
}

const derivedOf = (j: TaskRefs) =>
  taskDerived({
    heldAt: j.base.heldAt,
    droppedAt: j.base.droppedAt,
    hasAttempt: j.att.hasAttempt,
    hasCompleted: j.att.hasCompleted,
    hasActive: j.att.hasActive,
    hasWaiting: j.att.hasWaiting,
    hasBlockingDep: j.blocking.has,
    minPushAt: j.att.minPushAt,
  });

// The three derived fields, one spelling for both forms below.
const derivedColumns = {
  status: (j: TaskRefs) =>
    expr(derivedOf(j).status, {
      decoder: parsed(TaskStatusSchema, "tasks.status"),
      sqlType: "text",
      notNull: true,
    }),
  active: (j: TaskRefs) =>
    expr(derivedOf(j).active, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
    }),
  finishedAt: (j: TaskRefs) =>
    expr(derivedOf(j).finishedAt, {
      decoder: _tasks.droppedAt,
      sqlType: "timestamp with time zone",
    }),
};

/** The whole ordered set (`taskRows`). */
export const taskRowsServeOptions = {
  from: _tasks,
  joins,
  columns: { ...derivedColumns, dependencies: (j) => j.deps.list },
} satisfies ServeAllCollectionOptions<
  typeof _tasks,
  TaskListItem,
  typeof joins
>;

/** The same row as a window (`taskWindow`): the stored aggregates filter and sort like columns. */
export const taskWindowServeOptions = {
  from: _tasks,
  joins,
  columns: { ...derivedColumns, dependencies: (j) => j.deps.list },
} satisfies ServeCollectionOptions<typeof _tasks, TaskListItem, typeof joins>;
