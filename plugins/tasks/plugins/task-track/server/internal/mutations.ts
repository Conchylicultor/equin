import { and, asc, eq, inArray } from "drizzle-orm";
import {
  tasksView,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/server";
import { db, type DbExecutor } from "@plugins/database/server";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { DEFAULT_TASK_TRACK, type TaskTrack } from "../../core";
import { tasksTrack } from "./tables";
import { taskTrackChanged } from "./tables-events";

/** The task's track: its stored row, or the default (main) when it has none. */
export async function getTaskTrack(taskId: string): Promise<TaskTrack> {
  const row = await tasksTrack.get(taskId);
  return row ? row.track : DEFAULT_TASK_TRACK;
}

// The default track deletes the row (absence IS main); any other upserts it.
// The live collection is invalidated by the DB change-feed, so every surface
// re-renders.
//
// `exec` lets a caller that creates the task in a transaction set its track in
// that same transaction — the pool cannot see an uncommitted task row, so the
// side-table's FK to it would fail there.
export async function setTaskTrack(
  taskId: string,
  track: TaskTrack,
  exec: DbExecutor = db,
): Promise<void> {
  if (track === DEFAULT_TASK_TRACK) {
    await tasksTrack.delete(taskId, exec);
  } else {
    await tasksTrack.upsert(taskId, { track }, exec);
  }
  // On the writing executor, so the event commits (or rolls back) with the
  // row. Same PgTransaction ⇄ EmitTx cast as tasks-core's emits.
  await taskTrackChanged.emit(
    { taskId, track },
    exec === db ? undefined : { tx: exec as EmitTx },
  );
}

/**
 * The sidequests among `taskIds`. A dependency splice (a main-track followup
 * taking its target's place) reads this to leave the target's sidequests where
 * they are: a sidequest runs after its target and is never moved onto a chain.
 * `exec` lets the splice read it inside its own transaction.
 */
export async function listSidequestIds(
  taskIds: readonly string[],
  exec: DbExecutor = db,
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const t = tasksTrack.table;
  const rows = await exec
    .select({ taskId: t.taskId })
    .from(t)
    .where(and(inArray(t.taskId, [...taskIds]), eq(t.track, "sidequest")));
  return new Set(rows.map((r) => r.taskId));
}

/** A sidequest as `listSidequestTasks` reads it. */
export interface SidequestTask {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
}

/**
 * The sidequests whose derived status is one of `statuses`, OLDEST first, at
 * most `limit` — e.g. the ones ready to start (`new`: no attempt, and not
 * held, dropped or blocked). One `tasks_v` read, bounded by `limit` whatever
 * the backlog's size.
 */
export async function listSidequestTasks(opts: {
  statuses: readonly TaskStatus[];
  limit: number;
}): Promise<SidequestTask[]> {
  if (opts.statuses.length === 0) return [];
  const t = tasksTrack.table;
  return db
    .select({
      id: tasksView.id,
      title: tasksView.title,
      description: tasksView.description,
      createdAt: tasksView.createdAt,
    })
    .from(t)
    .innerJoin(tasksView, eq(tasksView.id, t.taskId))
    .where(
      and(
        eq(t.track, "sidequest"),
        inArray(tasksView.status, [...opts.statuses]),
      ),
    )
    .orderBy(asc(tasksView.createdAt), asc(tasksView.id))
    .limit(opts.limit);
}
