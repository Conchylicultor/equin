import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * The record a task is ABOUT: a failed build run, a deploy run, a job run. The
 * `kind` is the caller's own word for its record type (`build-run`,
 * `job-run`, …) and `id` that record's id in its own ledger — tasks names no
 * kind. One subject has at most one live task: launching about a subject that
 * already has one (not dropped) reuses it (`POST /api/tasks/launch`).
 */
export const TaskSubjectSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});
export type TaskSubject = z.infer<typeof TaskSubjectSchema>;

// The `tasks_ext_subject` entity-extension table (1:1 per task): written once,
// when a launch names a subject; never edited, never inherited by subtasks.
export const taskSubjectShape = defineExtensionShape({
  key: "taskId",
  fields: { subjectKind: textField(), subjectId: textField() },
});

const SubjectTaskSchema = z.object({ taskId: z.string().nullable() });
export type SubjectTask = z.infer<typeof SubjectTaskSchema>;

// The live task about one subject, `taskId: null` when there is none (never
// filed, or its task was dropped). Live, so a surface flips to "View task"
// the moment the launch lands — and back if the task is dropped.
export const subjectTask = liveValue("task-subject.by-subject", {
  schema: SubjectTaskSchema,
  params: ["kind", "id"],
});
