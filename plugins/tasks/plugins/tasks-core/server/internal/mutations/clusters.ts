import { eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@plugins/database/server";
import { _taskDependencies, _tasks } from "../tables";
import type { DbExecutor } from "../status-batch";

// Reads over `tasks.cluster_id`, the persisted, MONOTONE union-find label the
// dependency surfaces read one cluster of (`taskClusterRows`). Two tasks are in
// the same cluster iff they carry the same label; an edge write unions, an edge
// removal does nothing. The label is WRITTEN only by the database — the union
// runs in triggers on the edge writes, and a label write leaving an edge across
// clusters is refused (`../cluster-triggers.ts`) — so nothing here writes it.
// See `research/2026-08-03-tasks-monotone-deps-tree-membership.md`.

/**
 * The cluster label a task currently carries (`clusterId`: total — a task never
 * unioned carries its own id, written on insert). A missing task is a caller
 * bug and throws.
 *
 * A pure READ, unlocked: a concurrent union can move the task's cluster right
 * after it. Never decide a label from it — the database writes labels.
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
 * from one task needs that cluster's rows and no other. The database keeps it
 * (`../cluster-triggers.ts`: every edge write unions, a crossing edge refuses
 * the write), so empty is the only answer a committed state can give; the
 * suite reads it as the oracle.
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
