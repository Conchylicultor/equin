import { serveValue } from "@plugins/network/plugins/live/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { subjectTask } from "../../core";
import { findSubjectTask } from "./subject-task";
import { tasksSubject } from "./tables";

// Change-feed driven: the loader reads the side table and `tasks`, so a link
// written or a task dropped recomputes the subscribed subjects.
export const subjectTaskServed = serveValue(subjectTask, {
  source: "db",
  reads: {
    tables: [tasksSubject.table, _tasks],
    reason:
      "a subject's live task joins the subject links to the tasks they name; a link written or a task dropped may change any subject, whole-table until it reads through a collection",
  },
  loader: async ({ kind, id }) => ({
    taskId: await findSubjectTask({ kind, id }),
  }),
});
