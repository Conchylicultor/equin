import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskAutoStart } from "../../core";
import { tasksAutoStart } from "./tables";

// Server half of the per-task marker read: the lookup-only collection served
// from the extension entity (`taskId` is its `parent_id` PK; the projection is
// exactly the row schema, so createdAt/updatedAt stay off the wire). The loader
// reads only the subscribed id set, and the `:rows` point routing schedules an
// arm, disarm, claim or sweep of one task's marker for that task's tuple alone,
// never recomputing the whole table.
export const taskAutoStartServed = serveCollection(taskAutoStart, {
  from: tasksAutoStart,
});
