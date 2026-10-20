import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskTracks } from "../../core";
import { tasksTrack } from "./tables";

// The whole ordered set and its `:rows` point sibling, both routed over
// `tasks_ext_track` (the extension handle: `taskId` is the `parent_id` PK, the
// projection exactly the row schema). Marking a task a sidequest is an entrant
// (one refill + one `orderOf`), moving it back to main or the task's delete
// (FK cascade) an exit with no load. The `:rows` point sibling answers the
// single-task reads.
export const taskTracksServed = serveCollection(taskTracks, {
  from: tasksTrack,
});
