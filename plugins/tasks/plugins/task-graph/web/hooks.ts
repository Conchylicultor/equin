import { useMemo } from "react";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  TaskListItem,
  TaskRow,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  useTaskCluster,
  type TaskCluster,
} from "@plugins/tasks/plugins/tasks-core/web";

export interface TaskClosure {
  /** The task's dependency closure, including the task itself. */
  closure: readonly TaskListItem[];
  /** The task's cluster — the graph reads folder membership off it (a folder
   * and its children never leave one cluster). */
  allTasks: readonly TaskListItem[];
}

/**
 * The task's dependency closure, or `null` while its cluster is still loading
 * (or failed to load, or there is no such task) — NOT an empty closure, which
 * is a task with no edges and means something else entirely (it decides
 * whether the section is painted at all).
 */
export function useTaskClosure(taskId: string): TaskClosure | null {
  const result = useTaskCluster(taskId);
  return useMemo((): TaskClosure | null => {
    return foldResource(result, {
      loading: () => null,
      // The graph is an optional section: a failed read paints no card (the
      // task's own surfaces report the failure).
      error: () => null,
      ready: (cluster) => (cluster === null ? null : closureOf(cluster)),
    });
  }, [result]);
}

function closureOf({ task, rows, byId, graph }: TaskCluster): TaskClosure {
  // closure() excludes the queried id; re-include the root so it renders.
  const ids = graph.closure(task.id, { includeGroups: true }).map((n) => n.id);
  const closure = [task.id, ...ids]
    .map((id) => byId.get(id))
    .filter((t): t is TaskRow => !!t);
  return { closure, allTasks: rows };
}

/**
 * Section gate: a graph of one node is not a graph, and neither is one we
 * haven't loaded yet. Declared as `useAvailable` rather than a `return null` in
 * the body — a section with nothing to show must paint no card at all.
 */
export function useTaskGraphAvailable({ taskId }: { taskId: string }): boolean {
  const graph = useTaskClosure(taskId);
  return graph !== null && graph.closure.length > 1;
}
