import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskMandates } from "../../core";
import { tasksMandate } from "./tables-mandate";

// One task's effective mandate, by id, over `tasks_ext_mandate` (the
// extension handle: `taskId` is the `parent_id` PK).
export const taskMandatesServed = serveCollection(taskMandates, {
  from: tasksMandate,
});
