import { type LiveRowResult, useLive } from "@plugins/network/plugins/live/web";
import { taskPreprompts, type TaskPreprompt } from "../shared/schemas";

/**
 * The task's selected preprompt: its row of the lookup-only `taskPreprompts`
 * collection. `found: false` means none is selected; "not loaded yet" stays
 * the pending arm, so a selection can never read as "None".
 */
export function useTaskPreprompt(taskId: string): LiveRowResult<TaskPreprompt> {
  return useLive(taskPreprompts, { id: taskId });
}
