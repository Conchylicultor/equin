import { serveCollection } from "@plugins/network/plugins/live/server";
import { taskTriageNotes, taskTriageReads } from "../../core";
import { tasksTriage, tasksTriageNote } from "./tables";

// Served from the extension handles: a first request is an entrant, every
// state change a one-row refill, a task's deletion (FK cascade) an exit.
export const taskTriageReadsServed = serveCollection(taskTriageReads, {
  from: tasksTriage,
});
export const taskTriageNotesServed = serveCollection(taskTriageNotes, {
  from: tasksTriageNote,
});
