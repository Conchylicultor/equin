import { useCallback, useMemo } from "react";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  taskRows,
  TaskGraph,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { updateTask } from "../core";

// No `rank`: repositioning goes through the `moveTask` endpoint, which carries
// positional intent and mints the rank server-side against the complete sibling
// set. A client only ever holds a projection of that set.
export type TaskPatch = Partial<{
  title: string;
  description: string | null;
  drop: boolean;
  hold: boolean;
  folderId: string | null;
}>;

/**
 * Edit a task (title, description, drop, hold). Resolves once the server
 * holds the edit — the task's live rows follow by push — so a caller hands
 * the promise to its control (a `Button` pends on it, an editable field
 * settles on it). The returned function is stable.
 */
export function usePatchTask(): (
  id: string,
  patch: TaskPatch,
) => Promise<void> {
  const { mutateAsync } = useEndpointMutation(updateTask);
  return useCallback(
    (id, patch) => mutateAsync({ params: { id }, body: patch }).then(() => {}),
    [mutateAsync],
  );
}
/**
 * One task out of the live task set — a resource result whose ready arm is the
 * task, or `null` when the set is known and holds no such task (or `id` is
 * empty). Loading and a failed read stay their own states, so a caller never
 * mistakes "not known yet" or "could not be read" for "no such task".
 *
 * A `select` over the set: a caller re-renders when ITS task changes (an
 * untouched row keeps its identity across a push), not on every push.
 */
export function useTask(
  id: string | null | undefined,
): ResourceResult<TaskListItem | null> {
  const select = useCallback(
    (tasks: TaskListItem[]) =>
      id ? (tasks.find((t) => t.id === id) ?? null) : null,
    [id],
  );
  return useLive(taskRows, { select });
}

/**
 * Several tasks out of the live task list, by id — for a surface that lists
 * rows of its own keyed by task (an automation's history) and joins each to
 * its task. The ready arm maps every id the list holds; an id it does not hold
 * is absent from the map (a deleted task), which is a settled answer. Loading
 * and a failed read stay their own states, as in `useTask`.
 */
export function useTasksById(
  ids: readonly string[],
): ResourceResult<ReadonlyMap<string, TaskListItem>> {
  const result = useLive(taskRows);
  return useMemo(() => {
    const wanted = new Set(ids);
    return mapResource(
      result,
      (tasks) =>
        new Map(tasks.filter((t) => wanted.has(t.id)).map((t) => [t.id, t])),
    );
  }, [result, ids]);
}

// One TaskGraph per task-set snapshot, shared by every caller in a render pass.
// A plain `useLive(taskRows)` read hands every observer the SAME cached array,
// a fresh one whenever the set changes and never mutated in place, so the
// array's identity IS the graph's cache key — and the entry dies with the
// snapshot. Without this, a list of rows each showing a count
// rebuilds the whole graph once per row.
const GRAPH_BY_SNAPSHOT = new WeakMap<readonly TaskListItem[], TaskGraph>();

function graphFor(tasks: readonly TaskListItem[]): TaskGraph {
  const cached = GRAPH_BY_SNAPSHOT.get(tasks);
  if (cached) return cached;
  const graph = TaskGraph.from(tasks);
  GRAPH_BY_SNAPSHOT.set(tasks, graph);
  return graph;
}

/**
 * The number of ACTIVE tasks transitively blocked on `id` — the single
 * derivation shared by every surface that shows or acts on that count (the
 * conversation Tasks button, the per-row conversation chip, the drop-dependents
 * action), so two of them can never disagree about how many tasks are waiting.
 *
 * A resource result over the count: loading until the task set is known, error
 * when it failed to load. A count of `0` is a real answer ("nothing is waiting
 * on it"); the loading arm is what "we don't know yet" looks like, so a surface
 * can render a loading affordance instead of quietly claiming zero.
 */
export function useActiveDependentCount(
  id: string | null | undefined,
): ResourceResult<number> {
  const result = useLive(taskRows);
  // No task ⇒ zero once the set is known: nothing can wait on it.
  return mapResource(result, (tasks) =>
    id ? graphFor(tasks).activeDependents(id).length : 0,
  );
}
