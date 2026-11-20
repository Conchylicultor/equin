import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { TaskSubject } from "../../core";

/**
 * A listener on "a task was filed about a subject": the record's owner learns
 * which task now owns it — a failed build's report, say, takes the build's
 * Investigate task as its own, so a supervisor watching reports sees the
 * failure is already being worked. Matched on `subjectKind` (the caller's own
 * word for its record type), so tasks names no kind. Awaited inside the launch
 * that wrote the link: a listener that fails fails the launch, loudly.
 */
export interface TaskSubjectLinkedListener {
  id: string;
  subjectKind: string;
  onLinked(taskId: string, subject: TaskSubject): Promise<void>;
}

export const TaskSubjectLinked =
  defineServerContribution<TaskSubjectLinkedListener>("task-subject-linked", {
    // Complete: every listener must hear a link, so a process that files a
    // task about a subject starts them all (or the read throws, naming them).
    docLabel: (l) => `${l.subjectKind} → ${l.id}`,
  });
