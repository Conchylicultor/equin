import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { taskShortTitles, type TaskShortTitle } from "../core";

/**
 * The task's short title: its row of the lookup-only `taskShortTitles`
 * collection. `found: false` means none was generated; a found row is only
 * current while `row.sourceTitle` equals the task's title — compare before
 * showing it.
 */
export function useTaskShortTitle(
  taskId: string,
): LiveRowResult<TaskShortTitle> {
  return useLiveRow(taskShortTitles, taskId);
}
