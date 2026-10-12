import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { putTaskTrack } from "../core";
import { taskTracksServed } from "./internal/resource";
import { handlePutTaskTrack } from "./internal/routes";
import { taskTrackChanged } from "./internal/tables-events";

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
  description:
    "Owns the tasks_ext_track side-table: the per-task track (absence = main, a row = sidequest), its live collection (the whole set for the task list, point reads for one task), and the endpoint that switches a task's track, and the tasks.trackChanged trigger event every track write emits.",
  contributions: [...taskTracksServed.declare],
  register: [taskTrackChanged],
  httpRoutes: {
    [putTaskTrack.route]: handlePutTaskTrack,
  },
} satisfies ServerPluginDefinition;
