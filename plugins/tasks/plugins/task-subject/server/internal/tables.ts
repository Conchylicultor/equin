import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { taskSubjectShape } from "../../core";

// The subject read (`WHERE subject_kind = $1 AND subject_id = $2`) is keyed by
// something other than the task, so it needs its own index. Not unique: a
// dropped task keeps its row (the record of what it was about), and the
// subject's next launch files a new task beside it.
export const tasksSubject = defineExtension(
  _tasks,
  "subject",
  taskSubjectShape,
  {
    indexes: (t, b) => [b.index("subject").on(t.subjectKind, t.subjectId)],
  },
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _tasksSubjectExt = tasksSubject.table;
