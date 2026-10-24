import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskTriageNoteShape, taskTriageShape } from "../../core";

// A task's triage (see the shape): one row per task, the latest run winning;
// a task's deletion cascades it away. `state` is indexed for the dispatcher's
// queue and the stale sweep, `conversationId` for the conversation-status
// trigger (every conversation's status change looks its run up by it).
export const tasksTriage = defineExtension(_tasks, "triage", taskTriageShape, {
  indexes: (t, b) => [
    b.index("state").on(t.state, t.requestedAt),
    b.index("conversation").on(t.conversationId),
  ],
});
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksTriageExt = tasksTriage.table;

// A person's note about a task, fed to its triage runs (see the shape).
export const tasksTriageNote = defineExtension(
  _tasks,
  "triage_note",
  taskTriageNoteShape,
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksTriageNoteExt = tasksTriageNote.table;
