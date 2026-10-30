import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { db, type DbExecutor } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { EnqueueTx } from "@plugins/infra/plugins/jobs/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { isActiveStatus, isAgentBusy } from "@plugins/conversations/core";
import { listLaunchableArmedIn } from "@plugins/tasks/plugins/auto-start/server";
import { watchIdKind, type Watcher, type WatchId } from "../../core";
import { _taskWatches, tasksManager } from "./tables";

export type WatchRow = typeof _taskWatches.$inferSelect;

/** The statuses that make an agent busy, and the ones that end a
 * conversation — derived from the status predicates, never re-listed. */
const BUSY_STATUSES = ConversationStatusSchema.options.filter(isAgentBusy);
const ENDED_STATUSES = ConversationStatusSchema.options.filter(
  (s) => !isActiveStatus(s),
);

/** SQL: a parenthesised list of literals, for `IN`. */
function sqlList(values: readonly string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

/** `{ tx }` for an enqueue joining the caller's transaction; nothing on the
 * pool (Graphile's own connection). */
export function enqueueOn(exec: DbExecutor): { tx?: EnqueueTx } {
  return exec === db ? {} : { tx: exec as unknown as EnqueueTx };
}

/** One string per watcher: what makes `watchTask` idempotent per (task, watcher). */
export function watcherKeyOf(watcher: Watcher): string {
  return watcher.kind === "conversation"
    ? `conversation:${watcher.conversationId}`
    : `code:${watcher.handler}:${watcher.key}`;
}

/** SQL: watch `w` is live — not ended, and its conversation (if any) not ended. */
function liveWatchSql(): SQL {
  return sql`w.ended_at IS NULL AND (
      w.watcher_conversation_id IS NULL OR EXISTS (
        SELECT 1 FROM ${_conversations} lc
         WHERE lc.id = w.watcher_conversation_id
           AND lc.status NOT IN ${sqlList(ENDED_STATUSES)}))`;
}

/** SQL: `taskId` and its ancestors up `folder_id`, each with its depth. */
function chainSql(taskId: string): SQL {
  return sql`WITH RECURSIVE chain(id, folder_id, depth) AS (
      SELECT t.id, t.folder_id, 0 FROM ${_tasks} t WHERE t.id = ${taskId}
      UNION ALL
      SELECT p.id, p.folder_id, c.depth + 1
        FROM ${_tasks} p JOIN chain c ON p.id = c.folder_id
       WHERE c.depth < 1000
    )`;
}

async function watchesByIds(
  exec: DbExecutor,
  ids: readonly WatchId[],
): Promise<WatchRow[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .select()
    .from(_taskWatches)
    .where(inArray(_taskWatches.id, [...ids]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

const IdRow = z.object({ id: watchIdKind.schema });

/**
 * The live watch an event about `taskId` goes to: the nearest up the folder
 * chain (the task itself first), never one `excludeConversationId` owns — an
 * actor never hears its own action. Several on one task: the oldest.
 */
export async function nearestLiveWatch(
  exec: DbExecutor,
  taskId: string,
  excludeConversationId: string | null,
): Promise<WatchRow | null> {
  const rows = await executeRows(exec, {
    label: "watch nearest live",
    query: sql`${chainSql(taskId)}
      SELECT w.id::text AS id
        FROM chain c
        JOIN ${_taskWatches} w ON w.task_id = c.id
       WHERE ${liveWatchSql()}
         AND (${excludeConversationId}::text IS NULL
              OR w.watcher_conversation_id IS DISTINCT FROM ${excludeConversationId}::text)
       ORDER BY c.depth, w.created_at, w.id
       LIMIT 1`,
    row: IdRow,
  });
  const [first] = await watchesByIds(
    exec,
    rows.map((r) => r.id),
  );
  return first ?? null;
}

const ManagerRow = z.object({
  taskId: z.string(),
  managerTaskId: z.string().nullable(),
});

/**
 * Re-derive `tasks_ext_manager` for the subtrees rooted at `taskIds` (each
 * task and everything filed under it). A task is managed by the task of the
 * nearest live conversation watch up its folder chain — the task itself first,
 * then its ancestors (a watch covers its whole subtree), the oldest on one
 * task — never by its own agent (a tree watch on a root manages the tree below
 * it, not the root). The same rule events route by ({@link nearestLiveWatch}):
 * a sub-supervisor's conversation ending hands what it watched to the next
 * live watch above, so a supervisor root owns its whole tree. Writes only what
 * changed, so a refresh that moves nothing sends no row diff. Called on every
 * watch write, when a watcher's conversation ends or comes back (every input
 * of {@link liveWatchSql}), and when a task is created or re-filed (its chain).
 */
export async function refreshTaskManagers(
  exec: DbExecutor,
  taskIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return;
  const derived = await executeRows(exec, {
    label: "watch task managers",
    query: sql`WITH RECURSIVE sub(id) AS (
          SELECT t.id FROM ${_tasks} t WHERE t.id IN ${sqlList(ids)}
          UNION
          SELECT c.id FROM ${_tasks} c JOIN sub ON c.folder_id = sub.id
        ),
        chain(task_id, id, folder_id, depth) AS (
          SELECT t.id, t.id, t.folder_id, 0
            FROM ${_tasks} t JOIN sub ON sub.id = t.id
          UNION ALL
          SELECT c.task_id, p.id, p.folder_id, c.depth + 1
            FROM ${_tasks} p JOIN chain c ON p.id = c.folder_id
           WHERE c.depth < 1000
        )
      SELECT sub.id AS "taskId", m."managerTaskId"
        FROM sub
        LEFT JOIN (
          SELECT DISTINCT ON (c.task_id) c.task_id, a.task_id AS "managerTaskId"
            FROM chain c
            JOIN ${_taskWatches} w ON w.task_id = c.id
            JOIN ${_conversations} wc ON wc.id = w.watcher_conversation_id
            JOIN ${_attempts} a ON a.id = wc.attempt_id
           WHERE ${liveWatchSql()}
             AND a.task_id <> c.task_id
           ORDER BY c.task_id, c.depth, w.created_at, w.id
        ) m ON m.task_id = sub.id`,
    row: ManagerRow,
  });
  const derivedIds = derived.map((r) => r.taskId);
  if (derivedIds.length === 0) return;
  const current = new Map(
    (
      await exec
        .select()
        .from(tasksManager.table)
        .where(inArray(tasksManager.table.taskId, derivedIds))
    ).map((r) => [r.taskId, r.managerTaskId]),
  );
  for (const { taskId, managerTaskId } of derived) {
    const was = current.get(taskId) ?? null;
    if (was === managerTaskId) continue;
    if (managerTaskId === null) await tasksManager.delete(taskId, exec);
    else await tasksManager.upsert(taskId, { managerTaskId }, exec);
  }
}

/** Every live watch on `taskId`'s chain (itself and its ancestors) — the
 * watches whose subtree a change at `taskId` can make quiet or busy. */
export async function liveWatchesOnChain(
  exec: DbExecutor,
  taskId: string,
): Promise<WatchRow[]> {
  const rows = await executeRows(exec, {
    label: "watch live on chain",
    query: sql`${chainSql(taskId)}
      SELECT w.id::text AS id
        FROM chain c
        JOIN ${_taskWatches} w ON w.task_id = c.id
       WHERE ${liveWatchSql()}
       ORDER BY c.depth, w.created_at, w.id`,
    row: IdRow,
  });
  return watchesByIds(
    exec,
    rows.map((r) => r.id),
  );
}

/** Whether a watch is live now (see {@link liveWatchSql}). */
export async function isWatchLive(
  exec: DbExecutor,
  watchId: WatchId,
): Promise<boolean> {
  const rows = await executeRows(exec, {
    label: "watch is live",
    query: sql`SELECT w.id::text AS id FROM ${_taskWatches} w
       WHERE w.id = ${watchId} AND ${liveWatchSql()}`,
    row: IdRow,
  });
  return rows.length > 0;
}

export async function getWatch(
  exec: DbExecutor,
  watchId: WatchId,
): Promise<WatchRow | null> {
  const [row] = await watchesByIds(exec, [watchId]);
  return row ?? null;
}

/**
 * Whether anything still runs or will run on its own in `taskId`'s subtree
 * (itself included): an agent busy on one of its tasks (other than
 * `exceptConversationId`, the watcher's own), or an armed task that can
 * launch (not blocked, held or dropped).
 */
export async function subtreeActive(
  exec: DbExecutor,
  taskId: string,
  exceptConversationId: string | null,
): Promise<boolean> {
  const [row] = await executeRows(exec, {
    label: "watch subtree activity",
    query: sql`WITH RECURSIVE sub(id) AS (
          SELECT ${taskId}::text
          UNION
          SELECT c.id FROM ${_tasks} c JOIN sub ON c.folder_id = sub.id
        )
        SELECT EXISTS (
                 SELECT 1 FROM sub
                   JOIN ${_attempts} a ON a.task_id = sub.id
                   JOIN ${_conversations} cv ON cv.attempt_id = a.id
                  WHERE cv.status IN ${sqlList(BUSY_STATUSES)}
                    AND (${exceptConversationId}::text IS NULL
                         OR cv.id <> ${exceptConversationId}::text)
               ) AS busy,
               COALESCE(array_agg(sub.id), ARRAY[]::text[]) AS ids
          FROM sub`,
    row: z.object({ busy: z.boolean(), ids: z.array(z.string()) }),
  });
  if (!row) throw new Error("watch subtree activity returned no row");
  if (row.busy) return true;
  return (await listLaunchableArmedIn(row.ids, exec)).length > 0;
}

/**
 * Watch `taskId`'s subtree for `watcher`. Idempotent per (task, watcher): a
 * second call returns the live watch the first made. The watch starts with
 * the subtree's current quiet state, so only a later flip raises an event.
 */
export async function watchTask(
  taskId: string,
  watcher: Watcher,
  exec: DbExecutor = db,
): Promise<WatchRow> {
  const watcherKey = watcherKeyOf(watcher);
  const watcherConversationId =
    watcher.kind === "conversation" ? watcher.conversationId : null;
  const quiet = !(await subtreeActive(exec, taskId, watcherConversationId));
  const [inserted] = await exec
    .insert(_taskWatches)
    .values({
      id: watchIdKind.mint(),
      taskId,
      watcher,
      watcherKey,
      watcherConversationId,
      quiet,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await refreshTaskManagers(exec, [taskId]);
    return inserted;
  }
  const [existing] = await exec
    .select()
    .from(_taskWatches)
    .where(
      and(
        eq(_taskWatches.taskId, taskId),
        eq(_taskWatches.watcherKey, watcherKey),
        isNull(_taskWatches.endedAt),
      ),
    )
    .limit(1);
  if (!existing)
    throw new Error(
      `watchTask(${taskId}, ${watcherKey}): the insert conflicted but no live watch is there`,
    );
  return existing;
}

/** End a watch: its subtree's events go to the next live watch above. */
export async function endWatch(
  watchId: WatchId,
  exec: DbExecutor = db,
): Promise<void> {
  const ended = await exec
    .update(_taskWatches)
    .set({ endedAt: new Date() })
    .where(and(eq(_taskWatches.id, watchId), isNull(_taskWatches.endedAt)))
    .returning({ taskId: _taskWatches.taskId });
  await refreshTaskManagers(
    exec,
    ended.map((r) => r.taskId),
  );
}

/** Hand a watch to another conversation (a watcher rolling over to a fresh
 * one): its undelivered events go with it. */
export async function retargetWatch(
  watchId: WatchId,
  conversationId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const watcher: Watcher = { kind: "conversation", conversationId };
  const [row] = await exec
    .update(_taskWatches)
    .set({
      watcher,
      watcherKey: watcherKeyOf(watcher),
      watcherConversationId: conversationId,
    })
    .where(and(eq(_taskWatches.id, watchId), isNull(_taskWatches.endedAt)))
    .returning({ taskId: _taskWatches.taskId });
  if (!row) throw new Error(`retargetWatch: no open watch ${watchId}`);
  await refreshTaskManagers(exec, [row.taskId]);
}

/**
 * Make `conversationId` the agent watching `taskId`'s whole tree: an open
 * agent watch already on the task is handed over to it (its undelivered events
 * go with it), else a new one is made. Idempotent; a code watch on the task is
 * left alone.
 */
export async function takeOverTreeWatch(
  taskId: string,
  conversationId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const [current] = await exec
    .select()
    .from(_taskWatches)
    .where(
      and(
        eq(_taskWatches.taskId, taskId),
        isNotNull(_taskWatches.watcherConversationId),
        isNull(_taskWatches.endedAt),
      ),
    )
    .orderBy(asc(_taskWatches.createdAt), asc(_taskWatches.id))
    .limit(1);
  if (current === undefined)
    await watchTask(taskId, { kind: "conversation", conversationId }, exec);
  else if (current.watcherConversationId !== conversationId)
    await retargetWatch(current.id, conversationId, exec);
}

/** The open (not ended) watches a conversation owns, oldest first. */
export async function watchesOf(
  conversationId: string,
  exec: DbExecutor = db,
): Promise<WatchRow[]> {
  return exec
    .select()
    .from(_taskWatches)
    .where(
      and(
        eq(_taskWatches.watcherConversationId, conversationId),
        isNull(_taskWatches.endedAt),
      ),
    )
    .orderBy(asc(_taskWatches.createdAt), asc(_taskWatches.id));
}
