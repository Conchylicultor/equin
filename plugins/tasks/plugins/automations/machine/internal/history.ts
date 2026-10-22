import { serveCollection } from "@plugins/network/plugins/live/machine";
import { automationTasks } from "../../core";
import { tasksOrigin } from "../../server/internal/tables";

// Served from the extension handle: `taskId` is the `parent_id` PK, the
// projection is exactly the row schema. Filing a task is a window entry;
// a task's deletion cascades its row away (an exit).
export const automationTasksServed = serveCollection(automationTasks, {
  from: tasksOrigin,
});
