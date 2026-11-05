import { asc, eq, inArray, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@plugins/database/server";
import { _taskDependencies, _tasks } from "../tables";
import type { DbExecutor } from "../status-batch";

// Union-find over `tasks.cluster_id`: the persisted, MONOTONE membership label
// the dependency tree renders. Two tasks are in the same tree iff they carry the
// same label. Edge creation unions; edge removal does nothing — membership grows
// and never shrinks, which is what keeps a task from vanishing from the tree when
// its last edge is detached. See
// `research/2026-08-03-tasks-monotone-deps-tree-membership.md`.

/**
 * The cluster label a task currently carries (`clusterId`: total — a task never
 * unioned carries its own id, written on insert). A missing task is a caller
 * bug and throws.
 *
 * A pure READ. Deliberately unlocked, so it must never be the read half of a
 * read-then-write that decides a label — a concurrent union can move the cluster
 * between the read and the write, leaving the writer's row on a label nobody
 * carries. `createTask` used to do exactly that and now calls
 * `unionTaskClusters` instead. To write a label, union.
 */
export async function clusterLabelOf(
  taskId: string,
  exec: DbExecutor = db,
): Promise<string> {
  const [row] = await exec
    .select({ clusterId: _tasks.clusterId })
    .from(_tasks)
    .where(eq(_tasks.id, taskId))
    .limit(1);
  if (!row) throw new Error(`Task not found: ${taskId}`);
  return row.clusterId;
}

/**
 * Merge the clusters of `a` and `b` into one, keeping `min(label)` as the
 * survivor. Idempotent, order-independent, and a no-op when the two are already
 * in the same cluster.
 *
 * **The `FOR UPDATE` is load-bearing, not defensive.** Without it the plain
 * read-then-write loses updates at READ COMMITTED. Two concurrent unions sharing
 * one endpoint:
 *
 * ```
 * T1 union(A,B): reads labels 1,2 → UPDATE … WHERE cluster_id = 2
 * T2 union(B,C): reads labels 2,3 → UPDATE … WHERE cluster_id = 3
 * ```
 *
 * Neither statement's `WHERE` touches a row the other rewrites, so both commit
 * cleanly — and C is left stranded on label 2, a label nobody else carries any
 * more. That is the reported bug again, in a form no edge removal explains. The
 * row lock makes T2 block on B and re-read the latest committed version after T1
 * commits, so it computes `min(1,3)` against the truth.
 *
 * **`ORDER BY id`** gives the endpoint pair a consistent lock order, so two
 * transactions unioning the same pair from opposite directions queue instead of
 * deadlocking.
 *
 * **The relabel is one `WHERE cluster_id = $loser`**, on the plain
 * `tasks_cluster_id_idx`: the label is total (a never-unioned task carries its
 * own id), so the loser's whole cluster — a singleton included — is exactly
 * the rows carrying it.
 *
 * **Why `min` wins** — and explicitly NOT "the oldest": ids carry `task-`,
 * `claude-` and `legacy-claude-` prefixes, so lexicographic order is not
 * chronological order. `min` is chosen because it is associative and idempotent,
 * so the incremental union and a batch backfill agree by construction
 * (`min(min(A,B),C) = min(A,B,C)`), a repair pass is a no-op on already-correct
 * rows, and the label is stable under replay.
 *
 * The relabel does not move `updatedAt`: `clusterId` is declared as not
 * counting in the tasks entity's `touchedBy` (`tables.ts`), and the database
 * derives `updatedAt` from that declaration.
 *
 * **Handed the pool, this opens its own transaction.** A `FOR UPDATE` taken in
 * autocommit releases at statement end, so on the pool the lock-then-relabel
 * would be two independent transactions and the race above would be wide open —
 * the guarantee stated here would silently be false for exactly the callers that
 * pass no executor (`updateTask`'s folderId re-file). Rather than leave that as a
 * caller obligation nothing enforces, the primitive is correct on its own: pass a
 * `tx` to join an enclosing transaction, pass nothing and it makes one.
 */
export async function unionTaskClusters(
  a: string,
  b: string,
  exec: DbExecutor = db,
): Promise<void> {
  if (a === b) return;
  if (exec === db) {
    await db.transaction((tx) => unionOnTx(a, b, tx));
    return;
  }
  await unionOnTx(a, b, exec);
}

async function unionOnTx(
  a: string,
  b: string,
  exec: DbExecutor,
): Promise<void> {
  const rows = await exec
    .select({ id: _tasks.id, clusterId: _tasks.clusterId })
    .from(_tasks)
    .where(inArray(_tasks.id, [a, b]))
    .orderBy(asc(_tasks.id))
    .for("update");

  const rowA = rows.find((r) => r.id === a);
  const rowB = rows.find((r) => r.id === b);
  if (!rowA) throw new Error(`Task not found: ${a}`);
  if (!rowB) throw new Error(`Task not found: ${b}`);

  const la = rowA.clusterId;
  const lb = rowB.clusterId;
  if (la === lb) return;

  const winner = la < lb ? la : lb;
  const loser = la < lb ? lb : la;

  await exec
    .update(_tasks)
    .set({ clusterId: winner })
    .where(eq(_tasks.clusterId, loser));
}

/** An edge whose two ends carry different cluster labels. */
export interface ClusterEdgeViolation {
  kind: "dependency" | "folder" | "group";
  from: string;
  to: string;
}

/**
 * Every edge that leaves a cluster — THE invariant the cluster-scoped read
 * (`taskClusterRows`) rests on: a task's dependencies (both ways), its folder
 * chain and its group are all inside its cluster, so a reader walking them
 * from one task needs that cluster's rows and no other. Each edge kind is a
 * union point — `addTaskDependency`, `createTask` (folder and group) and
 * `prepareRefile` union before the edge commits — and no edge write happens
 * anywhere else. Empty is the only correct answer; the union-point suite
 * holds every writer to it.
 */
export async function clusterEdgeViolations(
  exec: DbExecutor = db,
): Promise<ClusterEdgeViolation[]> {
  const other = alias(_tasks, "other");
  const dependencies = await exec
    .select({
      from: _taskDependencies.taskId,
      to: _taskDependencies.dependsOnTaskId,
    })
    .from(_taskDependencies)
    .innerJoin(_tasks, eq(_tasks.id, _taskDependencies.taskId))
    .innerJoin(other, eq(other.id, _taskDependencies.dependsOnTaskId))
    .where(ne(_tasks.clusterId, other.clusterId));
  const folders = await exec
    .select({ from: _tasks.id, to: other.id })
    .from(_tasks)
    .innerJoin(other, eq(other.id, _tasks.folderId))
    .where(ne(_tasks.clusterId, other.clusterId));
  const groups = await exec
    .select({ from: _tasks.id, to: other.id })
    .from(_tasks)
    .innerJoin(other, eq(other.id, _tasks.groupId))
    .where(ne(_tasks.clusterId, other.clusterId));
  return [
    ...dependencies.map((e) => ({ kind: "dependency" as const, ...e })),
    ...folders.map((e) => ({ kind: "folder" as const, ...e })),
    ...groups.map((e) => ({ kind: "group" as const, ...e })),
  ];
}
