import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskTracks } from "../../core";
import { tasksTrack } from "./tables";

// The `:rows` point resource, routed over `tasks_ext_track` (the extension
// handle: `taskId` is the `parent_id` PK, the projection exactly the row
// schema). A track write reaches only the tuples naming that task.
export const taskTracksServed = serveCollection(taskTracks, {
  from: tasksTrack,
});
