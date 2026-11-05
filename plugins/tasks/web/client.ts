import { useCallback, useMemo } from "react";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  taskRows,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useTaskCluster } from "@plugins/tasks/plugins/tasks-core/web";
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
 * One task, by id — a resource result whose ready arm is the task, or `null`
 * when the task list holds no such task (or `id` is empty). Loading and a
 * failed read stay their own states, so a caller never mistakes "not known
 * yet" or "could not be read" for "no such task".
 *
 * A point read of the task's own row: a caller re-renders when ITS task
 * changes, and holds that row only, never the whole task set.
 */
export function useTask(
  id: string | null | undefined,
): ResourceResult<TaskListItem | null> {
  return mapRow(useLive(taskRows, { id: id ?? null }), (row) => row);
}

/**
 * Several tasks, by id — for a surface that lists rows of its own keyed by
 * task (an automation's history) and joins each to its task. A point-set read
 * of just those rows (`{ ids }`, at most the collection's `maxIds`). The ready
 * arm maps every id the list holds; an id it does not hold is absent from the
 * map (a deleted task), which is a settled answer. Loading and a failed read
 * stay their own states, as in `useTask`.
 */
export function useTasksById(
  ids: readonly string[],
): ResourceResult<ReadonlyMap<string, TaskListItem>> {
  const result = useLive(taskRows, { ids });
  return useMemo(
    () => mapResource(result, (tasks) => new Map(tasks.map((t) => [t.id, t]))),
    [result],
  );
}

/**
 * The number of ACTIVE tasks transitively blocked on `id` — the single
 * derivation shared by every surface that shows or acts on that count (the
 * conversation Tasks button, the per-row conversation chip, the drop-dependents
 * action), so two of them can never disagree about how many tasks are waiting.
 *
 * A resource result over the count: loading until the task's cluster is known, error
 * when it failed to load. A count of `0` is a real answer ("nothing is waiting
 * on it"); the loading arm is what "we don't know yet" looks like, so a surface
 * can render a loading affordance instead of quietly claiming zero.
 */
export function useActiveDependentCount(
  id: string | null | undefined,
): ResourceResult<number> {
  // Its dependents are all in its cluster. No such task ⇒ zero once that is
  // known: nothing can wait on it.
  const cluster = useTaskCluster(id);
  return mapResource(cluster, (c) =>
    c === null ? 0 : c.graph.activeDependents(c.task.id).length,
  );
}
