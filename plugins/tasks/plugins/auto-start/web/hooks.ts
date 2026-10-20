import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { taskAutoStart, type TaskAutoStartRow } from "../core";

/**
 * The task's auto-start marker: its row of the lookup-only `taskAutoStart`
 * collection. `found: false` means the task is not armed; "not loaded yet"
 * stays the pending arm, so an armed task can never read as unarmed during the
 * load window.
 */
export function useTaskAutoStart(
  taskId: string,
): LiveRowResult<TaskAutoStartRow> {
  return useLiveRow(taskAutoStart, taskId);
}
