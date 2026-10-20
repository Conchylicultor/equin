import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { putTaskTrack } from "../core";
import { taskTracksServed } from "./internal/resource";
import { handlePutTaskTrack } from "./internal/routes";
import { taskTrackChanged } from "./internal/tables-events";
import { tasksTrack } from "./internal/tables";

export {
  getTaskTrack,
  setTaskTrack,
  listSidequestIds,
  listSidequestTasks,
} from "./internal/mutations";
export type { SidequestTask } from "./internal/mutations";
export {
  taskTrackChanged,
  _taskTrackChangedTriggers,
} from "./internal/tables-events";
export type { TaskTrackChangedPayload } from "./internal/tables-events";

export default {
  portable: true,
  description:
    "Owns the tasks_ext_track side-table: the per-task track (absence = main, a row = sidequest), its live collection (the whole set for the task list, point reads for one task), the endpoint that switches a task's track, the tasks.trackChanged trigger event every track write emits, and the track exposed to every list whose rows reach a task (LiveColumns.Expose).",
  contributions: [
    ...taskTracksServed.declare,
    // The track, folded into every list whose rows reach a task.
    LiveColumns.Expose(tasksTrack),
  ],
  register: [taskTrackChanged],
  httpRoutes: {
    [putTaskTrack.route]: handlePutTaskTrack,
  },
} satisfies ServerPluginDefinition;
