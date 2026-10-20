import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { ConversationStatus } from "../../../core/conversation-status";
import { _attempts, _conversations } from "../tables";
import { conversations } from "../views";
import { emitConversationStatusChange } from "../status-emit";
import { noteAttributionChanged } from "../push-ledger/attribution";
import type { DbExecutor } from "../status-batch";
import { withTaskStatusChange } from "../status-scope";

export interface InsertConversationInput {
  id: string;
  attemptId: string;
  runtime: string;
  model: ConversationModel;
  spawnedBy: string;
  kind?: "user" | "agent" | "system";
  status?: "starting" | "working" | "waiting" | "gone" | "done";
  title?: string | null;
}

export interface UpdateConversationPatch {
  status?: "starting" | "working" | "waiting" | "gone" | "done";
  title?: string | null;
  claudeSessionId?: string | null;
  waitingFor?: string | null;
  endedAt?: Date | null;
  closeRequested?: boolean;
}

// Resolve the owning task id AND the current status of a conversation in one
// read. `taskId` is null when the conversation/attempt was already deleted (the
// task FK cascades, so this can happen during teardown); `status` is null in
// the same case. Callers snapshot the status before a write so they can emit a
// `conversation.statusChanged` transition afterwards.
async function conversationContext(
  conversationId: string,
): Promise<{ taskId: string | null; status: ConversationStatus | null }> {
  const [row] = await db
    .select({ taskId: _attempts.taskId, status: _conversations.status })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(eq(_conversations.id, conversationId))
    .limit(1);
  return {
    taskId: row?.taskId ?? null,
    status: (row?.status as ConversationStatus | undefined) ?? null,
  };
}

async function taskIdForAttempt(
  attemptId: string,
  exec: DbExecutor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ taskId: _attempts.taskId })
    .from(_attempts)
    .where(eq(_attempts.id, attemptId))
    .limit(1);
  return row?.taskId ?? null;
}

/**
 * THE conversation-row insert.
 *
 * Every creation in this plugin goes through here because a new conversation row
 * is not only a conversation: it changes what the push ledger can ATTRIBUTE, so
 * the ledger's freshness signature has to learn about it
 * (`push-ledger/attribution.ts`). A bump that has to be remembered at four call
 * sites is a bump that gets forgotten at the fifth — and the failure it causes is
 * silent, a commit left permanently deferred rather than an error anyone sees.
 * One funnel is the only version of that rule nobody can skip.
 *
 * The bump fires only when a row actually came back, so a conflict that inserted
 * nothing does not invalidate the memo over an attribution set that did not move.
 */
export async function insertConversationRow(
  exec: DbExecutor,
  values: (typeof _conversations)["$inferInsert"],
  opts: { ignoreConflict?: boolean } = {},
): Promise<(typeof _conversations)["$inferSelect"] | undefined> {
  const insert = exec.insert(_conversations).values(values);
  const [row] = await (
    opts.ignoreConflict ? insert.onConflictDoNothing() : insert
  ).returning();
  if (row) noteAttributionChanged();
  return row;
}

// `exec`: pass the transaction when the conversation must commit together with
// its attempt (see conversations' `commitConversation`) — the attempt lookup
// below then reads on that transaction, which is the only connection that can
// see an attempt it has not committed yet.
export async function insertConversation(
  input: InsertConversationInput,
  exec: DbExecutor = db,
) {
  const taskId = await taskIdForAttempt(input.attemptId, exec);
  // An orphan conversation (its attempt/task already deleted during teardown)
  // seeds the scope with NOTHING: an empty seed set costs no query and emits
  // nothing, which is the honest reading of "no task's status can have moved".
  await withTaskStatusChange(taskId ?? [], exec, async () => {
    await insertConversationRow(exec, {
      id: input.id,
      attemptId: input.attemptId,
      runtime: input.runtime,
      model: input.model,
      spawnedBy: input.spawnedBy,
      kind: input.kind ?? "user",
      status: input.status ?? "starting",
      title: input.title ?? null,
    });
  });
  const [row] = await exec
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.id))
    .limit(1);
  return row!;
}

export async function insertConversationOnConflictDoNothing(
  input: InsertConversationInput & {
    status: "starting" | "working" | "waiting" | "gone" | "done";
  },
) {
  const taskId = await taskIdForAttempt(input.attemptId);
  const row = await withTaskStatusChange(taskId ?? [], db, async () => {
    // A conflict inserts nothing, so the status is unchanged and the scope emits
    // nothing of its own accord — no `if (row)` guard needed here.
    return insertConversationRow(
      db,
      {
        id: input.id,
        attemptId: input.attemptId,
        runtime: input.runtime,
        model: input.model,
        spawnedBy: input.spawnedBy,
        kind: input.kind ?? "user",
        status: input.status,
        title: input.title ?? null,
      },
      { ignoreConflict: true },
    );
  });
  return row ?? null;
}

export async function updateConversation(
  id: string,
  patch: UpdateConversationPatch,
): Promise<void> {
  const { taskId, status: prevStatus } = await conversationContext(id);
  // Typed against the table's own insert row, not `Record<string, unknown>`:
  // `status` is a DECODED column now, so its encoder runs on this `.set(...)`.
  // A widened value would otherwise be a runtime throw from inside drizzle;
  // here it is a tsc error at the assignment that wrote it.
  // No `updatedAt` here: it is derived by the database from the columns the
  // entity declares as counting (`touchedBy` in `tables.ts`), and a write to
  // it raises.
  const dbPatch: Partial<(typeof _conversations)["$inferInsert"]> = {};
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.title !== undefined) dbPatch.title = patch.title;
  if (patch.claudeSessionId !== undefined)
    dbPatch.claudeSessionId = patch.claudeSessionId;
  if (patch.waitingFor !== undefined) dbPatch.waitingFor = patch.waitingFor;
  if (patch.endedAt !== undefined) dbPatch.endedAt = patch.endedAt;
  if (patch.closeRequested !== undefined)
    dbPatch.closeRequested = patch.closeRequested;
  // An empty patch writes nothing (drizzle rejects an empty SET).
  if (Object.keys(dbPatch).length === 0) return;

  await withTaskStatusChange(taskId ?? [], db, async () => {
    await db
      .update(_conversations)
      .set(dbPatch)
      .where(eq(_conversations.id, id));
  });
  if (patch.status !== undefined)
    await emitConversationStatusChange(id, taskId, prevStatus, patch.status);
}

export async function updateConversationsTitleForTask(
  taskId: string,
  title: string,
): Promise<void> {
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .innerJoin(_attempts, eq(_conversations.attemptId, _attempts.id))
    .where(and(eq(_attempts.taskId, taskId), isNull(_conversations.title)));

  if (rows.length === 0) return;

  await db
    .update(_conversations)
    .set({ title })
    .where(
      inArray(
        _conversations.id,
        rows.map((r) => r.id),
      ),
    );
}

export async function deleteConversationRow(id: string): Promise<void> {
  const { taskId, status: prevStatus } = await conversationContext(id);
  await withTaskStatusChange(taskId ?? [], db, async () => {
    await db.delete(_conversations).where(eq(_conversations.id, id));
  });
  // A hard delete cascades away the conversation's queue rank row (entity
  // extension, FK CASCADE). Emit a terminal transition so the queue refreshes
  // its ranks and revalidates the pin — the conversation is no longer present.
  if (prevStatus !== null)
    await emitConversationStatusChange(id, taskId, prevStatus, "done");
}

// Atomically transition to "gone" only if the current status is still active.
// Returns true if the row was updated, false if it was already gone/done.
// Prevents the status reconciler from overwriting a "done" set by the exit_clean flow.
export async function markConversationGone(id: string): Promise<boolean> {
  const { taskId, status: prevStatus } = await conversationContext(id);
  const now = new Date();
  const result = await withTaskStatusChange(taskId ?? [], db, async () =>
    db
      .update(_conversations)
      .set({
        status: "gone",
        endedAt: now,
        waitingFor: null,
      })
      .where(
        and(
          eq(_conversations.id, id),
          notInArray(_conversations.status, ["gone", "done"]),
        ),
      )
      .returning({ id: _conversations.id }),
  );
  if (result.length > 0) {
    await emitConversationStatusChange(id, taskId, prevStatus, "gone");
  }
  return result.length > 0;
}

// Hibernation flag (orthogonal to status): set a Date to mark the process
// intentionally absent, null to clear it on resume. Status is untouched —
// a hibernated conversation shows `waiting` (the status reconciler settles a
// row that still says `working` when it hibernates it). Only the status reconciler (suspend branch)
// and the idle-kill job set it; only `ensureResumed` clears it.
export async function setConversationHibernated(
  id: string,
  hibernatedAt: Date | null,
): Promise<void> {
  await db
    .update(_conversations)
    .set({ hibernatedAt })
    .where(eq(_conversations.id, id));
}

// Reset the idle timer: stamp lastViewedAt = now() when the user opens the
// conversation (and on every turn sent). Whether this moves `updatedAt` is
// decided by the conversations entity's `touchedBy` declaration in `tables.ts`
// (it does not: viewing is not a change to the record).
export async function touchConversationViewed(id: string): Promise<void> {
  await db
    .update(_conversations)
    .set({ lastViewedAt: new Date() })
    .where(eq(_conversations.id, id));
}

export async function markConversationClosed(
  id: string,
  endedAt: Date = new Date(),
): Promise<void> {
  const { taskId, status: prevStatus } = await conversationContext(id);
  await withTaskStatusChange(taskId ?? [], db, async () => {
    await db
      .update(_conversations)
      .set({ status: "done", endedAt })
      .where(eq(_conversations.id, id));
  });
  await emitConversationStatusChange(id, taskId, prevStatus, "done");
}
