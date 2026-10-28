import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  tasksFile,
  type TasksFileGrant,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";
import { describeFilingGrant } from "./add-task-filing";

// The grant's keys ARE the task tracks (tasks-core cannot import task-track):
// a track added to one side and not the other fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const tracksMatch: Same<keyof TasksFileGrant, TaskTrack> = true;
void tracksMatch;

function describeTasksFile(grant: TasksFileGrant): string {
  return `You may file tasks into this subtree with \`add_task\` — ${describeFilingGrant(grant)}. Any other track or start mode is refused.`;
}

/** How a `tasks.file` grant reads to the agent. */
export const tasksFileCapability = Mandate.Capability({
  cap: tasksFile,
  describe: describeTasksFile,
});
