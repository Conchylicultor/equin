import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import type { TaskSubject } from "../../core";
import { tasksSubject } from "./tables";

/** The live (not dropped) task about `subject`, or `null` when there is none. */
export async function findSubjectTask(
  subject: TaskSubject,
): Promise<string | null> {
  const t = tasksSubject.table;
  const [row] = await db
    .select({ taskId: t.taskId })
    .from(t)
    .innerJoin(_tasks, eq(_tasks.id, t.taskId))
    .where(
      and(
        eq(t.subjectKind, subject.kind),
        eq(t.subjectId, subject.id),
        isNull(_tasks.droppedAt),
      ),
    )
    .orderBy(desc(t.createdAt))
    .limit(1);
  return row?.taskId ?? null;
}

/** Record that `taskId` is about `subject`. */
export async function setTaskSubject(
  taskId: string,
  subject: TaskSubject,
): Promise<void> {
  await tasksSubject.upsert(taskId, {
    subjectKind: subject.kind,
    subjectId: subject.id,
  });
}

// Per-subject in-process mutex (the reports investigate pattern): two launches
// about one subject at once — a double click, two tabs — serialize, so the
// second observes the task the first linked instead of filing a duplicate.
// One server process per instance, so a JS-level lock is the whole story.
const subjectLocks = new Map<string, Promise<void>>();

/** Run `fn` holding the subject's lock. */
export async function withSubjectLock<T>(
  subject: TaskSubject,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${subject.kind}\u0000${subject.id}`;
  while (subjectLocks.has(key)) await subjectLocks.get(key);
  let release!: () => void;
  subjectLocks.set(key, new Promise<void>((r) => (release = r)));
  try {
    return await fn();
  } finally {
    subjectLocks.delete(key);
    release();
  }
}
