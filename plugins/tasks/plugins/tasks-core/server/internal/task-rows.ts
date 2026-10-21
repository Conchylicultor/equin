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
} from "@plugins/infra/plugins/query-resource/core";
import type { ServeAllCollectionOptions } from "@plugins/network/plugins/live/server";
import { TaskStatusSchema, type TaskListItem } from "../../core";
import {
  depIsBlocking,
  taskAttemptAggregates,
  taskDerived,
  type AttemptFacts,
  type SqlOperand,
} from "./derived";
import { attemptConvAgg, attemptPushAgg } from "./rollup-spec";
import { _attemptPushAgg } from "./rollup-table";
import { _attempts, _taskDependencies, _tasks } from "./tables";

// How `taskRows` (core: the whole ordered set of tasks, key `tasks`) binds to
// the database — the ONE spelling both the served collection
// (`./resources.ts`) and the tests (`./tree-oracle.test.ts`, which compiles it
// against a throwaway database; `./all-parity.test.ts`, which holds it equal
// to `tasks_v`) read, so neither can drift from what ships.
//
// It reads the BASE tables and the attempt rollups, never a view (A8): every
// row field but the four derived ones is a column of `tasks` by name, and the
// derived ones are `taskDerived` (./derived.ts) — the definition `tasks_v`
// interpolates — over three grouped joins:
//
//  - `att`, the task's attempts (children on `attempts.task_id`), each with
//    its two rollup rows: the per-task facts `taskAttemptAggregates` names.
//    An attempt / conversation / push write reaches its task through the
//    children route and the rollups' source routes (`conversations` and
//    `pushes`, carrying `attempt_id`).
//  - `deps`, the task's own edges (children on `task_dependencies.task_id`):
//    `dependencies`, the prerequisite ids in creation order.
//  - `blocking`, the transitive prerequisites (a closure over
//    `task_dependencies`, child `task_id` → parent `depends_on_task_id`),
//    each ancestor with its own attempts: `depIsBlocking` over every one. A
//    prerequisite's write reaches every task that depends on it, however
//    deep (the dependents probe).

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

const att = childrenJoin({
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
});

// Each transitive prerequisite's own attempts: is one of them completed?
const ancestorAtt = childrenJoin({
  alias: "att",
  table: _attempts,
  fk: _attempts.taskId,
  rollups: [conv, push],
  aggregates: (c) => ({
    completed: flag(
      taskAttemptAggregates({
        ...attemptFacts(c),
        hasWaitingConv: c.conv.hasWaitingConv,
      }).hasCompleted,
    ),
  }),
});

const deps = childrenJoin({
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
});

const blocking = closureJoin({
  alias: "blocking",
  edges: _taskDependencies,
  child: _taskDependencies.taskId,
  parent: _taskDependencies.dependsOnTaskId,
  nodes: _tasks,
  ancestorJoins: [ancestorAtt],
  aggregates: (c) => ({
    has: flag(
      sql`bool_or(${depIsBlocking({
        droppedAt: c.anc.droppedAt,
        heldAt: c.anc.heldAt,
        hasCompleted: c.att.completed,
      })})`,
    ),
  }),
});

const joins = [att, deps, blocking] as const;

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

export const taskRowsServeOptions = {
  from: _tasks,
  joins,
  columns: {
    status: (j) =>
      expr(derivedOf(j).status, {
        decoder: parsed(TaskStatusSchema, "tasks.status"),
        sqlType: "text",
        notNull: true,
      }),
    active: (j) =>
      expr(derivedOf(j).active, {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
      }),
    finishedAt: (j) =>
      expr(derivedOf(j).finishedAt, {
        decoder: _tasks.droppedAt,
        sqlType: "timestamp with time zone",
      }),
    dependencies: (j) => j.deps.list,
  },
} satisfies ServeAllCollectionOptions<
  typeof _tasks,
  TaskListItem,
  typeof joins
>;
