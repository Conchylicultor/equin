import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  _attempts,
  _conversations,
  _tasks,
  getConversation,
  tasksView,
} from "@plugins/tasks/plugins/tasks-core/server";
import { mandateOf } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import type { DigestStore, DigestTask } from "./digest";
import { _digestCursors } from "./tables";

const DigestTaskRow = z.object({
  id: z.string(),
  folder_id: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  rank: z.string(),
});

function toTask(r: z.infer<typeof DigestTaskRow>): DigestTask {
  return {
    id: r.id,
    folderId: r.folder_id,
    title: r.title,
    status: r.status,
    rank: r.rank,
  };
}

/** The database clock, read BEFORE the tasks: a change committed between this
 * read and the next is shown twice, never skipped. Read as epoch ms (float8):
 * a raw `db.execute` returns a `timestamptz` as its text, never a `Date`
 * (sql-rows' timestamp trap); `Date` truncating the microseconds only moves
 * the cursor earlier, the safe side. */
async function clock(): Promise<Date> {
  const [row] = await executeRows(db, {
    label: "tree digest clock",
    query: sql`SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms`,
    row: z.object({ ms: z.number() }),
  });
  if (!row) throw new Error("SELECT now() returned no row");
  return new Date(row.ms);
}

/** The subtree's tasks (root included) passing `filter` (over `t`, the base
 * row), with their derived status. Walks `folder_id` down by its index. */
async function readSubtree(
  rootTaskId: string,
  filter: SQL,
): Promise<DigestTask[]> {
  const rows = await executeRows(db, {
    label: "tree digest subtree",
    query: sql`WITH RECURSIVE sub(id) AS (
          SELECT ${rootTaskId}::text
          UNION
          SELECT c.id FROM ${_tasks} c JOIN sub ON c.folder_id = sub.id
        )
        SELECT t.id, t.folder_id, t.title, v.status::text AS status, t.rank::text AS rank
          FROM sub
          JOIN ${_tasks} t ON t.id = sub.id
          JOIN ${tasksView} v ON v.id = t.id
         WHERE ${filter}`,
    row: DigestTaskRow,
  });
  return rows.map(toTask);
}

export const dbDigestStore: DigestStore = {
  async scopeOf(conversationId) {
    const conversation = await getConversation(conversationId);
    if (conversation === null) return null;
    const mandate = await mandateOf(conversation.taskId);
    if (mandate.kind === "none") return null;
    return { taskId: conversation.taskId, rootTaskId: mandate.rootTaskId };
  },

  async cursorOf(conversationId, rootTaskId) {
    const [row] = await db
      .select({ seenAt: _digestCursors.seenAt })
      .from(_digestCursors)
      .where(
        and(
          eq(_digestCursors.conversationId, conversationId),
          eq(_digestCursors.rootTaskId, rootTaskId),
        ),
      )
      .limit(1);
    return row ? row.seenAt : null;
  },

  async subtree(rootTaskId) {
    const at = await clock();
    return { tasks: await readSubtree(rootTaskId, sql`TRUE`), at };
  },

  async changedSince(rootTaskId, since) {
    const at = await clock();
    // A task "changed" when it was created, its own row moved (its derived
    // `updated_at`), or one of its attempts or their conversations did — the
    // facts its derived status reads.
    const tasks = await readSubtree(
      rootTaskId,
      sql`(t.created_at > ${since} OR t.updated_at > ${since}
           OR EXISTS (
             SELECT 1 FROM ${_attempts} a
              WHERE a.task_id = t.id
                AND (a.updated_at > ${since}
                     OR EXISTS (SELECT 1 FROM ${_conversations} cv
                                 WHERE cv.attempt_id = a.id AND cv.updated_at > ${since}))
           ))`,
    );
    return { tasks, at };
  },

  async advance(conversationId, rootTaskId, at) {
    await db
      .insert(_digestCursors)
      .values({ conversationId, rootTaskId, seenAt: at })
      .onConflictDoUpdate({
        target: [_digestCursors.conversationId, _digestCursors.rootTaskId],
        set: { seenAt: at },
      });
  },
};
