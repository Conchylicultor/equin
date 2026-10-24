import { and, count, eq, inArray, lt } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { tasksView } from "@plugins/tasks/plugins/tasks-core/server";
import { tasksSubject } from "@plugins/tasks/plugins/task-subject/server";
import {
  normalizeTriageResult,
  parseTriageRead,
  type TriageRead,
  type TriageResult,
  type TriageState,
} from "../../core";
import { tasksTriage, tasksTriageNote } from "./tables";

const t = tasksTriage.table;

/** The subject kind a triage run's own task is filed about (the triaged task's id). */
export const TRIAGE_SUBJECT_KIND = "task-triage";

/** The text a triage read is about, as the task holds it now. */
export interface TriagedTask {
  title: string;
  /** `""` for a task with no description — the snapshot's spelling too. */
  description: string;
  createdAt: Date;
}

/** The task's current text, or `null` for a task that does not exist. */
export async function readTriagedTask(
  taskId: string,
): Promise<TriagedTask | null> {
  const [task] = await db
    .select({
      title: tasksView.title,
      description: tasksView.description,
      createdAt: tasksView.createdAt,
    })
    .from(tasksView)
    .where(eq(tasksView.id, taskId));
  if (task === undefined) return null;
  return {
    title: task.title,
    description: task.description ?? "",
    createdAt: task.createdAt,
  };
}

/** Whether `taskId` is a triage run's own task (`Triage: …`), never triaged itself. */
export async function isTriageRunTask(taskId: string): Promise<boolean> {
  const subject = await tasksSubject.get(taskId);
  return subject?.subjectKind === TRIAGE_SUBJECT_KIND;
}

/** One task's triage, parsed — `null` when it was never asked for. */
export async function getTriageRead(
  taskId: string,
): Promise<TriageRead | null> {
  const row = await tasksTriage.get(taskId);
  return row === undefined ? null : parseTriageRead(row);
}

/** The triage of `taskIds`, keyed by task (absent ⇒ never asked for). */
export async function triageReadsOf(
  taskIds: readonly string[],
): Promise<Map<string, TriageRead>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(t)
    .where(inArray(t.taskId, [...taskIds]));
  return new Map(rows.map((r) => [r.taskId, parseTriageRead(r)]));
}

/** The person's note about the task, `null` when there is none. */
export async function getTriageNote(taskId: string): Promise<string | null> {
  const row = await tasksTriageNote.get(taskId);
  return row?.note ?? null;
}

/** The person's notes about `taskIds`, keyed by task (absent ⇒ no note). */
export async function triageNotesOf(
  taskIds: readonly string[],
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const n = tasksTriageNote.table;
  const rows = await db
    .select({ taskId: n.taskId, note: n.note })
    .from(n)
    .where(inArray(n.taskId, [...taskIds]));
  return new Map(rows.map((r) => [r.taskId, r.note]));
}

/** Set (or, blank, delete) the person's note about the task. */
export async function setTriageNote(
  taskId: string,
  note: string,
): Promise<void> {
  if (note.trim() === "") {
    await tasksTriageNote.delete(taskId);
    return;
  }
  await tasksTriageNote.upsert(taskId, { note });
}

/**
 * Queue a run of `taskId`: a first request inserts the row; a later one keeps
 * the previous read on it (the run's `previous`) and resets the run fields.
 */
export async function markQueued(taskId: string, now: Date): Promise<void> {
  const existing = await tasksTriage.get(taskId);
  if (existing === undefined) {
    await tasksTriage.upsert(taskId, {
      state: "queued",
      staleReason: null,
      sourceTitle: null,
      sourceDescription: null,
      conversationId: null,
      runTaskId: null,
      requestedAt: now,
      startedAt: null,
      triagedAt: null,
      error: null,
      verdict: null,
      priority: null,
      taskType: null,
      risk: null,
      context: null,
      question: null,
      answers: [],
      answer: null,
      areas: [],
      mainSha: null,
    });
    return;
  }
  await tasksTriage.update(taskId, {
    state: "queued",
    staleReason: null,
    requestedAt: now,
    startedAt: null,
    error: null,
  });
}

/** The run of `taskId` starts now (its conversation is recorded once launched). */
export async function markRunning(taskId: string, now: Date): Promise<void> {
  await tasksTriage.update(taskId, {
    state: "running",
    startedAt: now,
    conversationId: null,
    error: null,
  });
}

/** The run's conversation and its own task, once launched. */
export async function recordLaunch(
  taskId: string,
  launch: { conversationId: string; runTaskId: string },
): Promise<void> {
  await tasksTriage.update(taskId, launch);
}

/** The latest run of `taskId` ended without a read. */
export async function markFailed(taskId: string, error: string): Promise<void> {
  await tasksTriage.update(taskId, { state: "failed", error });
}

/**
 * Store a submitted read: `done`, with the task's text snapshot it describes.
 * It replaces whatever the row held (a resumed follow-up's resubmit updates
 * the read); the person's answer is kept only while the new read still
 * offers it.
 */
export async function recordRead(args: {
  taskId: string;
  conversationId: string;
  result: TriageResult;
  task: TriagedTask;
  mainSha: string;
  now: Date;
}): Promise<void> {
  const result = normalizeTriageResult(args.result);
  const existing = await tasksTriage.get(args.taskId);
  const answer =
    existing?.answer != null && result.answers.includes(existing.answer)
      ? existing.answer
      : null;
  await tasksTriage.upsert(args.taskId, {
    state: "done",
    staleReason: null,
    sourceTitle: args.task.title,
    sourceDescription: args.task.description,
    conversationId: args.conversationId,
    runTaskId: existing?.runTaskId ?? null,
    requestedAt: existing?.requestedAt ?? args.now,
    startedAt: existing?.startedAt ?? null,
    triagedAt: args.now,
    error: null,
    verdict: result.verdict,
    priority: result.priority,
    taskType: result.taskType,
    risk: result.risk,
    context: result.context,
    question: result.question,
    answers: result.answers,
    answer,
    areas: result.areas,
    mainSha: args.mainSha,
  });
}

/**
 * Mark the `done` read of `taskId` stale (edited) when the task's text no
 * longer matches the snapshot it was read from. A title write that changes
 * nothing (creation, a Haiku upgrade to the same text) leaves it fresh.
 * Returns whether it went stale.
 */
export async function markStaleIfEdited(taskId: string): Promise<boolean> {
  const row = await tasksTriage.get(taskId);
  if (row === undefined || row.state !== "done") return false;
  const task = await readTriagedTask(taskId);
  if (task === null) return false;
  if (
    row.sourceTitle === task.title &&
    row.sourceDescription === task.description
  ) {
    return false;
  }
  // Conditional on `done`, so a resubmit landing in between is not undone.
  const updated = await db
    .update(t)
    .set({ state: "stale", staleReason: "edited" })
    .where(and(eq(t.taskId, taskId), eq(t.state, "done")))
    .returning({ taskId: t.taskId });
  return updated.length > 0;
}

/** Mark every `done` read older than `before` stale (old). Returns how many. */
export async function markOldReadsStale(before: Date): Promise<number> {
  const updated = await db
    .update(t)
    .set({ state: "stale", staleReason: "old" })
    .where(and(eq(t.state, "done"), lt(t.triagedAt, before)))
    .returning({ taskId: t.taskId });
  return updated.length;
}

/**
 * Fail every run that started before `before` and never submitted — the
 * backstop for a conversation that died without a status change, so a stuck
 * row cannot hold a slot for good. Returns how many.
 */
export async function failStuckRuns(
  before: Date,
  error: string,
): Promise<number> {
  const updated = await db
    .update(t)
    .set({ state: "failed", error })
    .where(and(eq(t.state, "running"), lt(t.startedAt, before)))
    .returning({ taskId: t.taskId });
  return updated.length;
}

/** The running row whose run is `conversationId`, if any. */
export async function runningTriageOf(
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ taskId: t.taskId })
    .from(t)
    .where(and(eq(t.conversationId, conversationId), eq(t.state, "running")))
    .limit(1);
  return row?.taskId ?? null;
}

/** How many rows are in `state`. */
export async function countInState(state: TriageState): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(t)
    .where(eq(t.state, state));
  if (row === undefined) throw new Error("count() returned no row");
  return row.n;
}

/** The oldest `limit` queued requests, oldest first. */
export async function oldestQueued(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select({ taskId: t.taskId })
    .from(t)
    .where(eq(t.state, "queued"))
    .orderBy(t.requestedAt, t.taskId)
    .limit(limit);
  return rows.map((r) => r.taskId);
}
