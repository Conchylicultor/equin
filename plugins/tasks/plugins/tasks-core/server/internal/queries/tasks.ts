import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  nextRankUnder,
  withRank,
  type RankExecutor,
} from "@plugins/primitives/plugins/rank/server";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { _taskDependencies, _tasks } from "../tables";
import { directDepIsBlocking, taskBlocking, tasks } from "../views";
import type { Task, TaskStatus } from "../schema";
import { TaskGraph } from "../../../core";
import type { DbExecutor } from "../status-batch";
import {
  MandatePolicySchema,
  type MandatePolicy,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * A task's effective mandate: the policy stated on the nearest task up its
 * folder chain (itself included), and the task that states it — the root of
 * the subtree the policy covers. `none` only for a task that does not exist:
 * every root carries one (the `tasks_root_has_mandate` CHECK).
 */
export type NearestMandate =
  | { kind: "found"; rootTaskId: string; policy: MandatePolicy }
  | { kind: "none" };

/**
 * Walks `folder_id` up from `taskId` (a recursive CTE, cycle-guarded by depth
 * order) and takes the first non-null `mandate` — nearest wins.
 */
export async function nearestMandate(
  taskId: string,
  exec: DbExecutor,
): Promise<NearestMandate> {
  const rows = await executeRows(exec, {
    label: "task nearest mandate",
    query: sql`WITH RECURSIVE chain(id, folder_id, mandate, depth) AS (
          SELECT t.id, t.folder_id, t.mandate, 0
            FROM ${_tasks} t
           WHERE t.id = ${taskId}
          UNION ALL
          SELECT p.id, p.folder_id, p.mandate, c.depth + 1
            FROM ${_tasks} p
            JOIN chain c ON p.id = c.folder_id
           WHERE c.mandate IS NULL
        )
        SELECT id, mandate FROM chain
         WHERE mandate IS NOT NULL
         ORDER BY depth
         LIMIT 1`,
    row: z.object({ id: z.string(), mandate: MandatePolicySchema }),
  });
  const [row] = rows;
  return row
    ? { kind: "found", rootTaskId: row.id, policy: row.mandate }
    : { kind: "none" };
}

export async function listTasks(exec: DbExecutor = db): Promise<Task[]> {
  const rows = await exec
    .select()
    .from(tasks)
    .orderBy(asc(tasks.rank), asc(tasks.createdAt));
  return rows.map(withRank);
}

export async function getTask(id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ? withRank(row) : null;
}

// True iff any task in `taskId`'s TRANSITIVE dependency closure is unresolved —
// neither dropped nor backed by a completed attempt (held deps still block).
// Reads the shared `task_blocking_v` view (see views.ts) so the auto-start gate
// and the UI status badge derive blocking from one definition rather than two
// hand-mirrored single-hop queries. A task with no row in the view has no
// dependencies → not blocked.
//
// `exec` is REQUIRED — see the note on `listBlockingDepIds` below.
export async function hasBlockingDep(
  taskId: string,
  exec: DbExecutor,
): Promise<boolean> {
  const [row] = await exec
    .select({ blocking: taskBlocking.hasBlockingDep })
    .from(taskBlocking)
    .where(eq(taskBlocking.taskId, taskId))
    .limit(1);
  return row?.blocking ?? false;
}

export async function findNextRankInFolder(
  folderId: string | null,
  executor: RankExecutor = db,
): Promise<Rank> {
  return nextRankUnder(_tasks, _tasks.folderId, folderId, executor);
}

// True if candidateId is a descendant of ancestorId in the folder hierarchy.
// Used to prevent circular re-filing.
export async function isDescendant(
  ancestorId: string,
  candidateId: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const all = await exec
    .select({ id: _tasks.id, folderId: _tasks.folderId })
    .from(_tasks);
  const byId = new Map(all.map((r) => [r.id, r.folderId] as const));
  let cur: string | null = candidateId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = byId.get(cur) ?? null;
  }
  return false;
}

// Intentionally SINGLE-HOP DIRECT (distinct from the transitive `task_blocking_v`
// / TaskGraph.activeBlockers): callers feed the result to `rankAfterBlockers` and
// walk the frontier themselves, so this must stay the direct-dependency frontier,
// not the transitive closure. Do NOT "consolidate" it onto the transitive view.
//
// `exec` is REQUIRED (no `= db` default) precisely so a caller inside a
// transaction cannot silently read off the pool: that would hold one connection
// while queueing for a second (hold-and-wait, fatal under pool exhaustion) and
// read a snapshot that misses the transaction's own uncommitted writes. Pass
// `tx` inside a transaction, `db` outside one.
export async function listBlockingDepIds(
  taskId: string,
  exec: DbExecutor,
): Promise<string[]> {
  const rows = await exec
    .select({ depTaskId: _taskDependencies.dependsOnTaskId })
    .from(_taskDependencies)
    .innerJoin(_tasks, eq(_tasks.id, _taskDependencies.dependsOnTaskId))
    .where(
      and(
        eq(_taskDependencies.taskId, taskId),
        // The SHARED rule (views.ts) — single-hop in shape, identical in
        // substance to the transitive task_blocking_v walk. Notably it treats a
        // held dependency as still blocking even once an attempt completed.
        directDepIsBlocking(sql`${_taskDependencies.dependsOnTaskId}`),
      ),
    );
  return rows.map((r) => r.depTaskId);
}

// `exec` is REQUIRED for the same reason as `listBlockingDepIds` above: a
// defaulted executor let a transaction-bound caller silently query the pool.
export async function listDependentIds(
  taskId: string,
  exec: DbExecutor,
): Promise<string[]> {
  const rows = await exec
    .select({ taskId: _taskDependencies.taskId })
    .from(_taskDependencies)
    .where(eq(_taskDependencies.dependsOnTaskId, taskId));
  return rows.map((r) => r.taskId);
}

// The transitive-dependents CLOSURE of `seedIds`, the seeds themselves
// included: exactly the set of tasks whose derived status a write recorded
// against a seed can change. Influence in `tasks_v` flows downstream only — a
// task's status reads its own drop/hold flags, its own attempts, and
// `task_blocking_v.has_blocking_dep`, which is a function of its ANCESTORS —
// so the dependents walk IS the affected set. See `status-scope.ts` for the
// proof, and for why the closure is the same either side of an edge write.
//
// ONE recursive CTE for the whole seed array rather than one walk per seed: the
// walk dedupes across seeds, and `UNION` (not `UNION ALL`) is also what makes a
// cycle terminate. Cycles are barred on insert by `taskDependsOn`, but a
// hand-written SQL edit is bound by nothing, and a non-terminating recursive CTE
// inside an interactive transaction is not a failure mode worth leaving open.
//
// `exec` is REQUIRED for the same reason as `listBlockingDepIds` above.
export async function listDependentClosure(
  seedIds: readonly string[],
  exec: DbExecutor,
): Promise<string[]> {
  if (seedIds.length === 0) return [];
  // Drizzle expands a JS array inside a `sql` template into a comma-separated
  // list of bound params, never a single array value, so the seed set is built
  // as an explicit `ARRAY[…]` constructor (the idiom live-state-snapshot's
  // `tables_read` uses). The seeds are unnested rather than selected back out of
  // `tasks`, because a seed row need not exist yet: `createTask` records its own
  // id before the INSERT that creates it.
  const seeds = sql.join(
    seedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await executeRows(exec, {
    label: "task dependent closure",
    query: sql`WITH RECURSIVE closure(id) AS (
          SELECT unnest(ARRAY[${seeds}]::text[])
          UNION
          SELECT td.task_id
            FROM ${_taskDependencies} td
            JOIN closure c ON td.depends_on_task_id = c.id
        )
        SELECT id FROM closure`,
    row: z.object({ id: z.string() }),
  });
  return rows.map((r) => r.id);
}

export interface TaskStatusRow {
  status: TaskStatus;
  folderId: string | null;
}

// The derived status (and folder) of a SET of tasks, in ONE read. Tasks that do
// not exist are simply absent from the map — the caller distinguishes "gone"
// from "unchanged" itself.
//
// Batching is not an optimization here, it is the whole reason a status scope is
// affordable: a `tasks_v` status read is O(the whole dependency graph) no matter
// how many ids it asks for, because `task_blocking_v`'s recursive ancestors CTE
// takes no predicate pushdown. N single-id reads therefore cost N × O(graph).
//
// `folderId` rides along because `tasks_v` carries every base column, which is
// why the emit path needs no separate folder read.
export async function readTaskStatuses(
  ids: readonly string[],
  exec: DbExecutor,
): Promise<Map<string, TaskStatusRow>> {
  if (ids.length === 0) return new Map();
  const rows = await exec
    .select({ id: tasks.id, status: tasks.status, folderId: tasks.folderId })
    .from(tasks)
    .where(inArray(tasks.id, [...ids]));
  return new Map(
    rows.map(
      (r) => [r.id, { status: r.status, folderId: r.folderId }] as const,
    ),
  );
}

export async function getTaskDependencyIds(
  taskId: string,
  exec: DbExecutor = db,
): Promise<string[]> {
  const rows = await exec
    .select({ dependsOnTaskId: _taskDependencies.dependsOnTaskId })
    .from(_taskDependencies)
    .where(eq(_taskDependencies.taskId, taskId));
  return rows.map((r) => r.dependsOnTaskId);
}

// True if `start` (transitively) depends on `target`. Used to prevent
// dependency cycles before inserting `target → start`. Structural and
// status-agnostic: routes through the shared TaskGraph so the last in-process
// server walk derives from the same model as every other traversal.
export async function taskDependsOn(
  start: string,
  target: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  return TaskGraph.from(await listTasks(exec)).dependsOn(start, target);
}
