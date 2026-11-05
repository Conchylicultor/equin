import { useMemo } from "react";
import {
  foldResource,
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  taskClusterRows,
  taskRows,
  TaskGraph,
  type TaskRow,
} from "@plugins/tasks/plugins/tasks-core/core";

/**
 * A task's dependency cluster (`tasks.cluster_id`, the monotone union-find
 * label): every task its dependency edges (both ways), its folder chain and
 * its group reach — and the tasks once linked to it, membership never
 * shrinking. A reader walking those edges from one task holds this and
 * nothing more.
 */
export interface TaskCluster {
  /** The task the cluster was read for. */
  task: TaskRow;
  /** Every task of the cluster, `task` included, in task-list order. */
  rows: readonly TaskRow[];
  byId: ReadonlyMap<string, TaskRow>;
  /** The dependency graph over `rows`. */
  graph: TaskGraph;
}

interface ClusterIndex {
  byId: ReadonlyMap<string, TaskRow>;
  graph: TaskGraph;
}

// One index per cluster snapshot, shared by every reader of it in a render
// pass: a plain scoped read hands every observer the SAME cached array, a
// fresh one whenever the cluster changes, so its identity is the cache key —
// and the entry dies with the snapshot. A list of rows each showing a
// dependent count builds the graph once, not once per row.
const INDEX_BY_SNAPSHOT = new WeakMap<readonly TaskRow[], ClusterIndex>();

function indexOf(rows: readonly TaskRow[]): ClusterIndex {
  const cached = INDEX_BY_SNAPSHOT.get(rows);
  if (cached) return cached;
  const index = {
    byId: new Map(rows.map((t) => [t.id, t])),
    graph: TaskGraph.from(rows),
  };
  INDEX_BY_SNAPSHOT.set(rows, index);
  return index;
}

/**
 * The cluster of task `taskId`: its row by id (`taskRows`' `:rows`), then its
 * cluster's rows (`taskClusterRows` at the row's `clusterId`). Ready `null`
 * when there is no such task (or no id); loading until both reads are known.
 *
 * `task` is the point read's row, never looked up in `rows`: a union moving
 * the task into another cluster reaches the two tuples in separate pushes, so
 * for a moment the new cluster's rows may not hold it yet — the walks still
 * answer by id (its edges are the other rows' `dependencies` and its own).
 */
export function useTaskCluster(
  taskId: string | null | undefined,
): ResourceResult<TaskCluster | null> {
  const row = useLive(taskRows, { id: taskId ?? null });
  const task = useMemo(() => mapRow(row, (r) => r), [row]);
  // The cluster's scope is known only once the task is: every other state of
  // the row read skips the cluster read, and the result below is that state.
  const clusterId = foldResource(task, {
    loading: () => null,
    error: () => null,
    ready: (t) => t?.clusterId ?? null,
  });
  const cluster = useLive(taskClusterRows, {
    where: clusterId === null ? null : { clusterId },
  });
  return useMemo(() => {
    if (task.status === "ready" && task.data !== null) {
      const found = task.data;
      return mapResource(cluster, (rows): TaskCluster | null => ({
        task: found,
        rows,
        ...indexOf(rows),
      }));
    }
    // Loading, failed, or no such task (ready `null`): the row read decides.
    return mapResource(task, (): TaskCluster | null => null);
  }, [task, cluster]);
}
