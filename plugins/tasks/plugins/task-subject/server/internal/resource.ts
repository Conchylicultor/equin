import { serveValue } from "@plugins/network/plugins/live/server";
import { subjectTask } from "../../core";
import { findSubjectTask } from "./subject-task";

// Change-feed driven: the loader reads the side table and `tasks`, so a link
// written or a task dropped recomputes the subscribed subjects.
export const subjectTaskServed = serveValue(subjectTask, {
  source: "db",
  loader: async ({ kind, id }) => ({
    taskId: await findSubjectTask({ kind, id }),
  }),
});
