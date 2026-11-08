import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";

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

// The tasks filed about each subject — what `subjectTask` follows, a scoped
// set by `{ where: { subjectKind, subjectId } }`. A link written about
// another subject reaches none of this subject's readers. Ordered by task id
// (the shape's row carries no timestamp): a launch reuses a subject's live
// task, so at most one link is live and the order only breaks a tie.
export const subjectLinks = liveCollection("task-subject-links", {
  from: taskSubjectShape,
  id: "taskId",
  all: {
    by: ["subjectKind", "subjectId"],
    orderBy: [["taskId", "asc"]],
    unbounded: {
      reason:
        "the tasks filed about one subject — one per launch about it, a handful",
      // Measured on main, 2026-11-08: 1.
      budget: 10,
    },
  },
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
