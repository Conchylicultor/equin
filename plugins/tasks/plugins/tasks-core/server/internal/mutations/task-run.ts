import { inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { _conversations } from "../tables";
import { conversationRunHandedOver } from "../tables-events";
import type { DbExecutor } from "../status-batch";

/**
 * Which conversation runs its task. The one with no stated mandate
 * (`conversations.mandate_ref` NULL) runs it — works under the task's mandate,
 * is the task's agent; one opened BESIDE it in the same attempt states
 * `interactive` (a side chat, never a second supervisor).
 *
 * The invariant kept here: **while an attempt has an open conversation, one
 * runs its task.** A side chat is a side chat only while the conversation it
 * was opened beside is open: once that one closes, the newest open side
 * conversation of the attempt (never a system one) takes over — its stated
 * mandate is cleared, so it works under the task's mandate from then on, and
 * `conversation.runHandedOver` tells it so. Before this, a user who carried a
 * task on in a new conversation and closed the old one was left with an agent
 * stuck at `interactive` while the task header said Supervisor
 * (task-1795221280-0armjx).
 */

/** Whether `attemptId` has an open conversation running its task — a new
 * conversation opened in it is then a side chat; otherwise it runs the task. */
export async function attemptHasOpenRunner(
  attemptId: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const rows = await executeRows(exec, {
    label: "attempt has open runner",
    row: z.object({ id: z.string() }),
    query: sql`SELECT id FROM ${_conversations}
       WHERE attempt_id = ${attemptId} AND mandate_ref IS NULL
         AND status <> 'done'
       LIMIT 1`,
  });
  return rows.length > 0;
}

/**
 * Hand each attempt's run to its newest open side conversation, for every
 * attempt among `scope` left with open conversations but none running its
 * task. `scope`: the attempt of one conversation (its close), or every
 * conversation this database created itself (the boot backstop:
 * `createdAfter` is its fork point, null when never forked — a fork's copies
 * of another database's rows are that database's to hand over, never this
 * one's). Writes on `exec` and announces the handed-over conversations in it;
 * returns their ids.
 */
export async function handOverTaskRuns(
  scope: { ofConversation: string } | { createdAfter: Date | null },
  exec: DbExecutor = db,
): Promise<string[]> {
  const inScope: SQL =
    "ofConversation" in scope
      ? sql`c.attempt_id = (SELECT attempt_id FROM ${_conversations}
                             WHERE id = ${scope.ofConversation})`
      : scope.createdAfter === null
        ? sql`TRUE`
        : sql`c.created_at > ${scope.createdAfter.toISOString()}::timestamptz`;
  const heirs = await executeRows(exec, {
    label: "task run heirs",
    row: z.object({ id: z.string() }),
    query: sql`
      SELECT DISTINCT ON (c.attempt_id) c.id
        FROM ${_conversations} c
       WHERE ${inScope}
         AND c.mandate_ref IS NOT NULL
         AND c.status <> 'done'
         AND c.kind <> 'system'
         AND NOT EXISTS (
           SELECT 1 FROM ${_conversations} r
            WHERE r.attempt_id = c.attempt_id
              AND r.mandate_ref IS NULL
              AND r.status <> 'done')
       ORDER BY c.attempt_id, c.created_at DESC, c.id DESC`,
  });
  const ids = heirs.map((h) => h.id);
  if (ids.length === 0) return ids;
  await exec
    .update(_conversations)
    .set({ mandateRef: null })
    .where(inArray(_conversations.id, ids));
  await conversationRunHandedOver.emit(
    { conversationIds: ids },
    exec === db ? undefined : { tx: exec as EmitTx },
  );
  return ids;
}
