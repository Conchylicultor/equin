import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import {
  _tasks,
  createTask,
  tasksView,
} from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import type { MandateRef } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { SLOT_SETTLED_STATUSES, type AutomationTaskRow } from "../../core";
import { FILED_CLOSED_STATUSES } from "./catalog-status";
import { tasksOrigin } from "./tables";

const t = tasksOrigin.table;

// A task an automation filed is OPEN until it is done or dropped. Held and
// attempted-without-a-push count as open: they are a person's to look at, and
// filing a second task beside one would only duplicate it. Only FILED rows: a
// task a launch-kind automation started is not a filing to dedupe against.
const isOpen = and(
  eq(t.role, "filed"),
  notInArray(tasksView.status, [...FILED_CLOSED_STATUSES]),
);

// A task a launch-kind automation started HOLDS one of its slots until it is
// released (its agent reported) or it settles on its own
// (`SLOT_SETTLED_STATUSES`).
const holdsSlot = and(
  eq(t.role, "launched"),
  isNull(t.releasedAt),
  notInArray(tasksView.status, [...SLOT_SETTLED_STATUSES]),
);

/** The open task `automationId` filed, newest first, or `null` when none is. */
export async function openAutomationTaskId(
  automationId: string,
  exec: DbExecutor = db,
): Promise<string | null> {
  const rows = await exec
    .select({ taskId: t.taskId })
    .from(t)
    .innerJoin(tasksView, eq(tasksView.id, t.taskId))
    .where(and(eq(t.automationId, automationId), isOpen))
    .orderBy(desc(t.filedAt))
    .limit(1);
  return rows[0]?.taskId ?? null;
}

/** Every automation's open task, keyed by automation id (absent ⇒ none open). */
export async function openAutomationTaskIds(
  exec: DbExecutor = db,
): Promise<Map<string, string>> {
  const rows = await exec
    .select({ automationId: t.automationId, taskId: t.taskId })
    .from(t)
    .innerJoin(tasksView, eq(tasksView.id, t.taskId))
    .where(isOpen)
    .orderBy(desc(t.filedAt));
  const open = new Map<string, string>();
  for (const r of rows) {
    if (!open.has(r.automationId)) open.set(r.automationId, r.taskId);
  }
  return open;
}

/**
 * The tasks `automationId` launched that still hold one of its slots, newest
 * first — its occupied slots.
 */
export async function occupiedSlotTaskIds(
  automationId: string,
  exec: DbExecutor = db,
): Promise<string[]> {
  const rows = await exec
    .select({ taskId: t.taskId })
    .from(t)
    .innerJoin(tasksView, eq(tasksView.id, t.taskId))
    .where(and(eq(t.automationId, automationId), holdsSlot))
    .orderBy(desc(t.filedAt));
  return rows.map((r) => r.taskId);
}

/** Every launch-kind automation's occupied slots, keyed by automation id
 * (absent ⇒ none), newest first. */
export async function occupiedSlotTaskIdsByAutomation(
  exec: DbExecutor = db,
): Promise<Map<string, string[]>> {
  const rows = await exec
    .select({ automationId: t.automationId, taskId: t.taskId })
    .from(t)
    .innerJoin(tasksView, eq(tasksView.id, t.taskId))
    .where(holdsSlot)
    .orderBy(desc(t.filedAt));
  const running = new Map<string, string[]>();
  for (const r of rows) {
    running.set(r.automationId, [
      ...(running.get(r.automationId) ?? []),
      r.taskId,
    ]);
  }
  return running;
}

/** Which of `taskIds` an automation already filed or launched. */
export async function taskIdsWithOrigin(
  taskIds: readonly string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await db
    .select({ taskId: t.taskId })
    .from(t)
    .where(inArray(t.taskId, [...taskIds]));
  return new Set(rows.map((r) => r.taskId));
}

/** `taskId`'s origin row, or `null` when no automation filed or launched it. */
export async function originOfTask(
  taskId: string,
): Promise<AutomationTaskRow | null> {
  return (await tasksOrigin.get(taskId)) ?? null;
}

/**
 * Record that `automationId` launched `taskId` (role `launched`), unless some
 * automation already filed or launched it: a task has ONE origin, and taking
 * over another's would hide it from that automation's dedupe and history.
 * Returns whether the row was written — `false` ⇒ launch nothing.
 */
export async function recordLaunch(
  automationId: string,
  taskId: string,
): Promise<boolean> {
  const written = await db
    .insert(t)
    .values({
      taskId,
      automationId,
      sourceKeys: [],
      filedAt: new Date(),
      role: "launched",
      releasedAt: null,
    })
    .onConflictDoNothing()
    .returning({ taskId: t.taskId });
  return written.length > 0;
}

/**
 * Give back the slot `taskId` holds: stamp its launched origin row released.
 * Returns the automation that launched it when this call released it, `null`
 * when there was nothing to release (no automation launched the task — e.g.
 * one a file-kind automation filed — or it was released already).
 */
export async function markLaunchReleased(
  taskId: string,
): Promise<string | null> {
  const [row] = await db
    .update(t)
    .set({ releasedAt: new Date() })
    .where(
      and(eq(t.taskId, taskId), eq(t.role, "launched"), isNull(t.releasedAt)),
    )
    .returning({ automationId: t.automationId });
  return row?.automationId ?? null;
}

/**
 * What an automation files: one task. Its description is the automation's
 * prompt template filled with `variables` (the registry adds `pushPolicy`).
 */
export interface AutomationFiling {
  title: string;
  /** A value for every `{{variable}}` the automation declares. */
  variables: Readonly<Record<string, string>>;
  /** The sources the task covers (stored on its origin row). */
  sourceKeys: readonly string[];
  /**
   * Called with the filed task's id once it exists — e.g. to link the records
   * it covers to it. A failure throws out of the run after the task is filed.
   */
  onFiled?: (taskId: string) => Promise<void>;
}

/**
 * File the task, stamp its category and record its origin, in ONE transaction:
 * a task without its origin row would be invisible to the dedupe, and the next
 * tick would file a second one beside it.
 */
export async function fileAutomationTask(args: {
  automationId: string;
  categoryId: string;
  filing: AutomationFiling;
  description: string;
  /** The mandate the filed (root) task names. */
  mandate: MandateRef;
}): Promise<string> {
  const { automationId, categoryId, filing, description, mandate } = args;
  return db.transaction(async (tx) => {
    const task = await createTask(
      {
        title: filing.title,
        titleAuto: false,
        author: `automation:${automationId}`,
        description,
        mandate,
      },
      tx,
    );
    await setTaskCategory(task.id, categoryId, tx);
    await tasksOrigin.upsert(
      task.id,
      {
        automationId,
        sourceKeys: [...filing.sourceKeys],
        filedAt: new Date(),
        role: "filed",
        releasedAt: null,
      },
      tx,
    );
    return task.id;
  });
}

/**
 * Record `automationId` as the origin of `taskIds` — tasks it filed before
 * origins were stored. Idempotent: a task that already has an origin keeps it.
 * `filedAt` is the task's own creation time. Returns how many were adopted.
 */
export async function adoptAutomationTasks(
  automationId: string,
  taskIds: readonly string[],
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const tasks = await db
    .select({ id: _tasks.id, createdAt: _tasks.createdAt })
    .from(_tasks)
    .where(inArray(_tasks.id, [...taskIds]));
  if (tasks.length === 0) return 0;
  const adopted = await db
    .insert(t)
    .values(
      tasks.map((task) => ({
        taskId: task.id,
        automationId,
        sourceKeys: [],
        filedAt: task.createdAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ taskId: t.taskId });
  return adopted.length;
}
