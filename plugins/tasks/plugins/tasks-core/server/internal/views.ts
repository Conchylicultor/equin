import { eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { boolean, pgView, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import { AttemptStatusSchema, TaskStatusSchema } from "../../core";
import { _attempts, _conversations, _taskDependencies, _tasks } from "./tables";
import { _attemptConvAgg, _attemptPushAgg } from "./rollup-table";
import {
  attemptDerived,
  depIsBlocking,
  taskAttemptAggregates,
  taskDerived,
} from "./derived";

// Derived (plain, non-materialized) views. These live in `views.ts` — NOT
// `schema.ts`/`tables.ts` — so the drizzle codegen glob never sees them: they
// are derived code rebuilt from source on every boot, declared via the `View`
// server contribution (see server/index.ts) + rebuildDerivedViews, never
// tracked in the migration chain. To change a view, edit it here and
// `./singularity build` — no migration is generated. See
// plugins/database/plugins/derived-views/CLAUDE.md.
//
// The view objects stay valid `pgView` relations so the rest of tasks-core can
// keep querying them with `db.select().from(...)`.
//
// The derivations themselves — an attempt's status / active / retained /
// finished_at, a task's per-attempt aggregates and status / active /
// finished_at, the blocking rule — live in `./derived.ts`, written once and
// interpolated here AND by the `tasks` live collection (`./task-rows.ts`),
// which reads the same base tables and rollups without these views. The
// all-parity suite pins the two equal row for row.
//
// The per-attempt aggregates are read from trigger-maintained rollup tables
// (attempt_conv_agg / attempt_push_agg — see rollup-spec.ts) instead of inline
// CTEs grouping ALL conversations + ALL pushes: a flat LEFT JOIN over two small
// pre-rolled tables. A missing rollup row reads as NULL via the LEFT JOIN,
// exactly as a missing CTE group did (preserving the pending / closed / active
// semantics for attempts with no conversations / pushes). tasks_v groups the
// same rollups per task, so neither view reads `conversations` or `pushes`.
// See plugins/database/plugins/derived-tables/CLAUDE.md.

// One attempt's two rollup rows, as `attempts_v` and `tasks_v` LEFT JOIN them.
const rollupFacts = {
  hasConv: _attemptConvAgg.hasConv,
  hasLiveConv: _attemptConvAgg.hasLiveConv,
  hasOpenConv: _attemptConvAgg.hasOpenConv,
  maxEndedAt: _attemptConvAgg.maxEndedAt,
  hasPush: _attemptPushAgg.hasPush,
  hasDelivery: _attemptPushAgg.hasDelivery,
  hasWorkingConv: _attemptConvAgg.hasWorkingConv,
  minPushAt: _attemptPushAgg.minPushAt,
};

export const attempts = pgView("attempts_v").as((qb) => {
  // The CASEs are `attemptDerived` (./derived.ts) — the one definition the
  // `tasks` collection reads too. What each arm reads, and why:
  //
  // I6 — EVERY ARM NAMES A FACT THE ROW PROVES. A `pushes` row may only
  // ever PROMOTE an attempt to a landed claim (`pushed` / `completed`); its
  // absence may never select a claim of its own. With no landed evidence the
  // status reports how the SESSION ended — which the conversation rollup does
  // prove — and says nothing about what did or did not land.
  //
  // The last arm used to be `ELSE 'abandoned'`, the one verdict in the whole
  // derivation reached from missing evidence. `has_push IS NULL` means at
  // least four different things — never pushed / finished with nothing to
  // push / landed on a commit carrying no attributable trailer (`--from-main`,
  // a hand-merge) / the ledger has not caught up — and it picked the most
  // damning. 1014 attempts read "Abandoned"; 128 of them sat on a task that
  // was neither dropped nor held.
  //
  // It also swallowed a case that has nothing to do with pushes at all:
  // hibernation writes `gone` on an idle pane, `gone` is not live but IS open
  // (and is exactly the status `resumeConversation` requires), so a live,
  // resumable attempt that had not pushed yet fell through to `abandoned`.
  // `has_open_conv` is what tells the two apart (`dormant`).
  //
  // A DELIVERY (a scratch workspace's landed fact) completes its attempt as
  // soon as no agent is working on it — the conversation may stay open and
  // repliable (a thread agent ends its turn instead of calling exit_clean), and
  // a follow-up turn reads `pushed` only while it runs. A push keeps waiting
  // for the conversation to end: a worktree agent that pushed may push again.
  //
  // Ordering: `dormant` sits BELOW the landed arms on purpose. It exists to
  // stop ABSENCE reading as abandonment, not to outrank a true claim — when
  // there is evidence, the evidence wins.
  //
  // Consequence, and the reason this is the view-layer twin of attempt-work's
  // I3: `attempts_v.status` can no longer contradict `standingOf`. The only
  // landed-claiming arm is backed by the very rows `standingOf` ORs into
  // "landed", and no arm claims "nothing landed" at all. See
  // research/2026-08-20-tasks-attempt-status-positive-evidence.md.
  //
  // `active` — PROGRESS: "an agent is expected to be running on this
  // attempt". Reads has_live_conv (`status NOT IN ('gone','done')`), so a
  // conversation whose process vanished reads inactive — the right answer for
  // the task list's in_progress / need_action / blocked badges. NOT A
  // RETENTION SIGNAL: never gate a destructive action on it — a `gone`
  // conversation is dormant, not finished.
  //
  // `retained` — RETENTION: "the user has not finished with this attempt, so
  // its worktree and fork DB are still theirs". Reads has_open_conv
  // (`status <> 'done'`), matching `isActiveStatus()` and
  // `conversations_v.active`. An attempt with no conversation yet is retained.
  // THIS is the guard every destructive consumer must read (worktree-cleanup's
  // reaper does). Gating deletion on `active` instead is what deleted the
  // checkouts of 22 live conversations.
  //
  // `finishedAt` — EXACTLY the two statuses that are over carry a finish
  // instant: `completed` (first arm) and `closed` (second). `has_conv` on the
  // first arm keeps `pending` out; `NOT has_open_conv` on the second keeps
  // `dormant` out. views.test.ts asserts the equivalence over the whole status
  // truth table.
  const a = attemptDerived(rollupFacts);
  // Every column but `workspace`, which is not part of `Attempt` (the
  // `attempts` collection's row, pinned by C39): it is read on its own, from
  // the `attemptWorkspaces` lookup or the table.
  const { workspace: _workspace, ...attemptColumns } =
    getTableColumns(_attempts);
  return qb
    .select({
      ...attemptColumns,
      status: a.status
        .mapWith(parsed(AttemptStatusSchema, "attempts_v.status"))
        .as("status"),
      active: a.active.mapWith(Boolean).as("active"),
      retained: a.retained.mapWith(Boolean).as("retained"),
      // Both non-NULL arms are `timestamptz`, so one column's decoder covers
      // the CASE. It has to be SOMEONE's: a raw projection carries drizzle's
      // no-op decoder, and drizzle's pg driver hands timestamps back as their
      // RAW STRING — the `Date` mapping lives on the column type. See
      // plugins/database/plugins/sql-projection/CLAUDE.md.
      finishedAt: a.finishedAt
        .mapWith(nullable(_attemptPushAgg.minPushAt))
        .as("finished_at"),
    })
    .from(_attempts)
    .leftJoin(_attemptConvAgg, eq(_attemptConvAgg.attemptId, _attempts.id))
    .leftJoin(_attemptPushAgg, eq(_attemptPushAgg.attemptId, _attempts.id));
});

// "Some attempt of task `taskId` is completed" / "is active", for the views'
// blocking rule — read off `attempts_v`, whose status and active flag are
// `attemptDerived`'s.
const hasCompletedAttempt = (taskId: SQL): SQL => sql`EXISTS (
        SELECT 1 FROM ${attempts} att
         WHERE att.task_id = ${taskId} AND att.status = 'completed'
      )`;
const hasActiveAttempt = (taskId: SQL): SQL => sql`EXISTS (
        SELECT 1 FROM ${attempts} att
         WHERE att.task_id = ${taskId} AND att.active
      )`;

// The single-hop frontier (queries/tasks.ts) interpolates the blocking rule
// (`depIsBlocking`, ./derived.ts) against the bare `tasks` relation joined to
// the dependency edge it is walking.
export const directDepIsBlocking = (dependsOnTaskId: SQL): SQL =>
  depIsBlocking({
    droppedAt: _tasks.droppedAt,
    heldAt: _tasks.heldAt,
    hasCompleted: hasCompletedAttempt(dependsOnTaskId),
    hasActive: hasActiveAttempt(dependsOnTaskId),
  });

// Transitive dependency-blocking, computed once as a shared derived view so the
// auto-start gate (hasBlockingDep) and the UI status badge (tasks_v) read the
// SAME definition instead of mirroring two single-hop queries. A task is blocked
// iff ANY task in its transitive dependency closure is unresolved — neither
// dropped nor backed by a completed attempt.
//
// Single-hop was only ever correct because completion propagates bottom-up: a
// task can't complete until its own deps resolved, so "direct dep done" implied
// "its ancestors done". `drop` breaks that invariant — it makes a node
// non-blocking WITHOUT resolving the node's own deps, punching a hole that a
// single JOIN can't see (A → B → C: dropping B unblocked C even with A pending).
// The recursive walk over depends_on edges closes the hole; UNION dedupes so
// cycles (already barred on insert by taskDependsOn) still terminate. Tasks with
// no dependencies produce no row — consumers COALESCE the absence to "not
// blocked".
//
// This recursive CTE is the SQL embodiment of `isSettled` / `TaskGraph.
// activeBlockers` (core/task-graph.ts): it walks *through* settled ancestors and
// blocks on ANY non-settled one — the same rule, in both directions. The
// per-ancestor test is `depIsBlocking` (./derived.ts), the shared definition the
// `tasks` collection's blocking closure reads too.
export const taskBlocking = pgView("task_blocking_v", {
  taskId: text("task_id").notNull(),
  hasBlockingDep: boolean("has_blocking_dep").notNull(),
}).as(
  sql`
    WITH RECURSIVE ancestors AS (
      SELECT td.task_id AS task_id, td.depends_on_task_id AS ancestor_id
        FROM ${_taskDependencies} td
      UNION
      SELECT a.task_id, td.depends_on_task_id
        FROM ancestors a
        JOIN ${_taskDependencies} td ON td.task_id = a.ancestor_id
    )
    SELECT a.task_id AS task_id,
           bool_or(${depIsBlocking({
             droppedAt: sql`dep.dropped_at`,
             heldAt: sql`dep.held_at`,
             hasCompleted: hasCompletedAttempt(sql`dep.id`),
             hasActive: hasActiveAttempt(sql`dep.id`),
           })}) AS has_blocking_dep
      FROM ancestors a
      JOIN ${_tasks} dep ON dep.id = a.ancestor_id
     GROUP BY a.task_id
  `,
);

// Per-task facts, set-at-a-time: grouped scans hash-joined to tasks.
// `task_attempt_agg` aggregates each task's attempts — their rollup rows,
// through `taskAttemptAggregates` (./derived.ts), the same aggregates the
// `tasks` collection's children join reads — and transitive
// dependency-blocking is read from the shared task_blocking_v view. The status
// / active / finished_at CASEs are `taskDerived`.
//
// It reads NO `conversations` and NO `pushes` (P8 v3 step 19): "waiting" is
// the conversation rollup's `has_waiting_conv` and the first push is the push
// rollup's `min_push_at`, so `view_table_usage` lists only `tasks`,
// `attempts`, the two rollups, `task_blocking_v` and `task_dependencies`.
export const tasks = pgView("tasks_v").as((qb) => {
  const agg = taskAttemptAggregates({
    ...rollupFacts,
    hasWaitingConv: _attemptConvAgg.hasWaitingConv,
  });
  const attemptAgg = qb.$with("task_attempt_agg").as(
    qb
      .select({
        taskId: _attempts.taskId,
        hasAttempt: agg.hasAttempt.mapWith(Boolean).as("has_attempt"),
        hasCompleted: agg.hasCompleted.mapWith(Boolean).as("has_completed"),
        hasActive: agg.hasActive.mapWith(Boolean).as("has_active"),
        hasWaiting: agg.hasWaiting.mapWith(Boolean).as("has_waiting"),
        minPushAt: agg.minPushAt
          .mapWith(nullable(_attemptPushAgg.minPushAt))
          .as("min_push_at"),
      })
      .from(_attempts)
      .leftJoin(_attemptConvAgg, eq(_attemptConvAgg.attemptId, _attempts.id))
      .leftJoin(_attemptPushAgg, eq(_attemptPushAgg.attemptId, _attempts.id))
      .groupBy(_attempts.taskId),
  );

  const deps = qb.$with("task_deps").as(
    qb
      .select({
        taskId: _taskDependencies.taskId,
        dependencies:
          sql`array_agg(${_taskDependencies.dependsOnTaskId} ORDER BY ${_taskDependencies.createdAt})`
            .mapWith(parsed(z.array(z.string()), "task_deps.dependencies"))
            .as("dependencies"),
      })
      .from(_taskDependencies)
      .groupBy(_taskDependencies.taskId),
  );

  const flag = (col: SQL.Aliased) => sql`COALESCE(${col}, false)`;
  const t = taskDerived({
    heldAt: _tasks.heldAt,
    droppedAt: _tasks.droppedAt,
    hasAttempt: flag(attemptAgg.hasAttempt),
    hasCompleted: flag(attemptAgg.hasCompleted),
    hasActive: flag(attemptAgg.hasActive),
    hasWaiting: flag(attemptAgg.hasWaiting),
    hasBlockingDep: sql`COALESCE(${taskBlocking.hasBlockingDep}, false)`,
    minPushAt: attemptAgg.minPushAt,
  });

  return qb
    .with(attemptAgg, deps)
    .select({
      ...getTableColumns(_tasks),
      status: t.status
        .mapWith(parsed(TaskStatusSchema, "tasks_v.status"))
        .as("status"),
      active: t.active.mapWith(Boolean).as("active"),
      // Every non-NULL arm (`min_push_at`, `dropped_at`) is a `timestamptz`,
      // so one column's decoder is what turns the driver's raw string into
      // the `Date` this column claims to be.
      finishedAt: t.finishedAt
        .mapWith(nullable(_attemptPushAgg.minPushAt))
        .as("finished_at"),
      dependencies: sql`COALESCE(${deps.dependencies}, ARRAY[]::text[])`
        .mapWith(parsed(z.array(z.string()), "tasks_v.dependencies"))
        .as("dependencies"),
    })
    .from(_tasks)
    .leftJoin(attemptAgg, eq(attemptAgg.taskId, _tasks.id))
    .leftJoin(taskBlocking, eq(taskBlocking.taskId, _tasks.id))
    .leftJoin(deps, eq(deps.taskId, _tasks.id));
});

// Conversation view adds derived fields from the attempt and task joins.
export const conversations = pgView("conversations_v").as((qb) =>
  qb
    .select({
      ...getTableColumns(_conversations),
      worktreePath: _attempts.worktreePath,
      taskId: _attempts.taskId,
      // The owning task's title, beside the conversation's own. Aliased: both
      // base tables have a `title` column, and a view cannot carry two. Read by
      // the conversations list, whose title mode can show the task's title
      // instead of the conversation's (History reads server-side, so a
      // client-side join on the unbounded tasks resource would not do).
      taskTitle: sql`${_tasks.title}`.mapWith(_tasks.title).as("task_title"),
      active: sql`(${_conversations.status} <> 'done')`
        .mapWith(Boolean)
        .as("active"),
    })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .innerJoin(_tasks, eq(_tasks.id, _attempts.taskId)),
);

// These view objects are declared as derived views via the `View` server
// contribution in this plugin's server barrel (server/index.ts). tasks_v
// declares `dependsOn: ["task_blocking_v"]` there (task_blocking_v in turn
// reads attempts_v); conversations_v is independent.
