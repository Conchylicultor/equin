import { type LiveRowResult, useLive } from "@plugins/network/plugins/live/web";
import { taskEfforts, type TaskEffort } from "../shared/schemas";

/**
 * The task's thinking mode: its row of the lookup-only `taskEfforts`
 * collection. `found: false` means none is set; "not loaded yet" stays the
 * pending arm, so a set mode can never read as unset.
 */
export function useTaskEffort(taskId: string): LiveRowResult<TaskEffort> {
  return useLive(taskEfforts, { id: taskId });
}
