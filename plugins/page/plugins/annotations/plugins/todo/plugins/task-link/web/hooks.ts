import {
  combineResources,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  mapRow,
  type LiveRowResult,
  useLive,
} from "@plugins/network/plugins/live/web";
import {
  taskRows,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { todoTasks, type TodoTaskLink } from "../shared/schemas";

/**
 * The task a TODO card has been dispatched onto: its row of the lookup-only
 * `todoTasks` collection. `found: false` means it has not been dispatched; "not
 * loaded yet" stays the pending arm, so a dispatched card never offers "Launch"
 * as if it were fresh. Callers that render the two the same (the run chips:
 * nothing either way) decide that themselves.
 */
export function useTodoTask(blockId: string): LiveRowResult<TodoTaskLink> {
  return useLive(todoTasks, { id: blockId });
}

/** A dispatched card's task, as the card's two surfaces need to render it. */
export interface TodoTaskState {
  taskId: string;
  title: string;
  status: TaskStatus;
}

/**
 * The linked task's LIVE title and status, joined client-side.
 *
 * The join is the whole point: the link row carries the task id and nothing
 * else, and the title and status come off the already boot-critical `tasks`
 * resource — the same one the task list renders. So a card's glyph follows the
 * task through every status change with nothing stored on the card and nothing
 * to keep in sync, which is the same read `page/prompt/block`'s chips make
 * against `attempts`.
 *
 * A resource result: loading while either side is hydrating, error when
 * either read failed, and on the ready arm the task — or `null` when the card
 * has not been dispatched, or its task is not in the tasks resource at all.
 * That last case is not a hole to fill: the link's `task_id` FK cascades, so
 * a deleted task takes its link row with it and both reads converge on "this
 * card has not been dispatched" — which is the truth, and is what frees the
 * card for a fresh dispatch. An undispatched card settles on the link alone:
 * it has no task to look up, so the task list's state does not reach it.
 */
export function useTodoTaskState(
  blockId: string,
): ResourceResult<TodoTaskState | null> {
  const taskId = mapRow(useTodoTask(blockId), (row) => row?.taskId ?? null);
  const tasks = useLive(taskRows);
  if (taskId.status === "ready" && taskId.data === null)
    return mapResource(taskId, () => null);
  return mapResource(
    combineResources({ taskId, tasks }),
    ({ taskId: id, tasks: list }): TodoTaskState | null => {
      const task = id === null ? undefined : list.find((t) => t.id === id);
      if (id === null || !task) return null;
      return { taskId: id, title: task.title, status: task.status };
    },
  );
}
