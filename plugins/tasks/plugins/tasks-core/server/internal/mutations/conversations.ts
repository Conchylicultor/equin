import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { ConversationStatus, ConversationWorkingOn } from "../../../core";
import { _attempts, _conversations, _tasks } from "../tables";
import { conversations } from "../views";
import {
  emitConversationStatusChange,
  type ConversationStatusState,
} from "../status-emit";
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
  /** Never `working`: only the status reconciler knows what a turn is busy on. */
  status?: Exclude<ConversationStatus, "working">;
  title?: string | null;
}

/**
 * A status write, with `workingOn` kept in step by construction: `working`
 * names what the agent is busy with, every other status clears it.
 */
type ConversationStatusPatch =
  | { status?: undefined; workingOn?: never }
  | { status: "working"; workingOn: ConversationWorkingOn }
  | { status: Exclude<ConversationStatus, "working">; workingOn?: never };

export type UpdateConversationPatch = ConversationStatusPatch & {
  title?: string | null;
  claudeSessionId?: string | null;
  waitingFor?: string | null;
  /** See the field: set while the reconciler cannot check `status`. */
  statusUnverifiedSince?: Date | null;
  endedAt?: Date | null;
  closeRequested?: boolean;
};

// Resolve the owning task id AND the current status (status + waitingFor) of
// a conversation in one read. `taskId` is null when the conversation/attempt
// was already deleted (the task FK cascades, so this can happen during
// teardown); `state` is null in the same case. Callers snapshot the state
// before a write so they can emit a `conversation.statusChanged` transition
// afterwards.
async function conversationContext(conversationId: string): Promise<{
  taskId: string | null;
  state: ConversationStatusState | null;
}> {
  const [row] = await db
    .select({
      taskId: _attempts.taskId,
      status: _conversations.status,
      waitingFor: _conversations.waitingFor,
    })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .where(eq(_conversations.id, conversationId))
    .limit(1);
  return {
    taskId: row?.taskId ?? null,
    state:
      row === undefined
        ? null
        : {
            status: row.status as ConversationStatus,
            waitingFor: row.waitingFor,
          },
  };
}

// The task an attempt belongs to: its id and current title. Null when the
// attempt is already gone (teardown). A new conversation is titled with the
// title its task has at that moment — the same copy
// `updateConversationsTitleForTask` keeps in step when the task's title is
// generated later — so a conversation launched on a task that is already
// titled (a relaunch, a follow-up attempt) is never left untitled.
async function taskOfAttempt(
  attemptId: string,
  exec: DbExecutor = db,
): Promise<{ taskId: string; title: string } | null> {
  const [row] = await exec
    .select({ taskId: _attempts.taskId, title: _tasks.title })
    .from(_attempts)
    .innerJoin(_tasks, eq(_tasks.id, _attempts.taskId))
    .where(eq(_attempts.id, attemptId))
    .limit(1);
  return row ?? null;
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
  const task = await taskOfAttempt(input.attemptId, exec);
  const taskId = task?.taskId ?? null;
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
      title: input.title ?? task?.title ?? null,
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
    status: Exclude<ConversationStatus, "working">;
  },
) {
  const task = await taskOfAttempt(input.attemptId);
  const taskId = task?.taskId ?? null;
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
        title: input.title ?? task?.title ?? null,
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
  const { taskId, state: prev } = await conversationContext(id);
  // Typed against the table's own insert row, not `Record<string, unknown>`:
  // `status` is a DECODED column now, so its encoder runs on this `.set(...)`.
  // A widened value would otherwise be a runtime throw from inside drizzle;
  // here it is a tsc error at the assignment that wrote it.
  // No `updatedAt` here: it is derived by the database from the columns the
  // entity declares as counting (`touchedBy` in `tables.ts`), and a write to
  // it raises.
  const dbPatch: Partial<(typeof _conversations)["$inferInsert"]> = {};
  if (patch.status !== undefined) {
    dbPatch.status = patch.status;
    dbPatch.workingOn = patch.status === "working" ? patch.workingOn : null;
  }
  if (patch.title !== undefined) dbPatch.title = patch.title;
  if (patch.claudeSessionId !== undefined)
    dbPatch.claudeSessionId = patch.claudeSessionId;
  if (patch.waitingFor !== undefined) dbPatch.waitingFor = patch.waitingFor;
  if (patch.statusUnverifiedSince !== undefined)
    dbPatch.statusUnverifiedSince = patch.statusUnverifiedSince;
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
  // A status or a `waitingFor` write is a status change (`waitingFor` refines
  // `waiting`: a question answered with the status unchanged must still wake
  // whoever holds a turn until the agent stops waiting). Neither known
  // before nor written: nothing to report.
  const status = patch.status ?? prev?.status;
  if (
    status !== undefined &&
    (patch.status !== undefined || patch.waitingFor !== undefined)
  )
    await emitConversationStatusChange(id, taskId, prev, {
      status,
      waitingFor:
        patch.waitingFor !== undefined
          ? patch.waitingFor
          : (prev?.waitingFor ?? null),
    });
}

// Copies a task's freshly generated title onto its conversations that still
// carry no title or the one it replaced (`replacing`: the placeholder or
// fallback the task was filed with, which `insertConversation` copied onto them).
// A conversation titled anything else keeps its title.
export async function updateConversationsTitleForTask(
  taskId: string,
  title: string,
  replacing: readonly string[],
): Promise<void> {
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .innerJoin(_attempts, eq(_conversations.attemptId, _attempts.id))
    .where(
      and(
        eq(_attempts.taskId, taskId),
        or(
          isNull(_conversations.title),
          inArray(_conversations.title, [...replacing]),
        ),
      ),
    );

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

// Re-points a conversation at another attempt. Both tasks' derived statuses may
// move (the scope is seeded with both), and the conversation → attempt map the
// push ledger attributes by moved with it, so the ledger's signature learns it
// (`push-ledger/attribution.ts`) — as for an insert. Its one caller is debug
// read-set's narrowing fixture: a move is the write that reaches both the old
// and the new attempt's live tuples.
export async function moveConversationToAttempt(
  id: string,
  attemptId: string,
): Promise<void> {
  const { taskId: fromTaskId } = await conversationContext(id);
  if (fromTaskId === null) throw new Error(`Unknown conversation "${id}"`);
  const to = await taskOfAttempt(attemptId);
  if (to === null) throw new Error(`Unknown attempt "${attemptId}"`);
  await withTaskStatusChange(
    [...new Set([fromTaskId, to.taskId])],
    db,
    async () => {
      await db
        .update(_conversations)
        .set({ attemptId })
        .where(eq(_conversations.id, id));
    },
  );
  noteAttributionChanged();
}

export async function deleteConversationRow(id: string): Promise<void> {
  const { taskId, state: prev } = await conversationContext(id);
  await withTaskStatusChange(taskId ?? [], db, async () => {
    await db.delete(_conversations).where(eq(_conversations.id, id));
  });
  // A hard delete cascades away the conversation's queue rank row (entity
  // extension, FK CASCADE). Emit a terminal transition so the queue refreshes
  // its ranks and revalidates the pin — the conversation is no longer present.
  if (prev !== null)
    await emitConversationStatusChange(id, taskId, prev, {
      status: "done",
      waitingFor: null,
    });
}

// Atomically transition to "gone" only if the current status is still active.
// Returns true if the row was updated, false if it was already gone/done.
// Prevents the status reconciler from overwriting a "done" set by the exit_clean flow.
export async function markConversationGone(id: string): Promise<boolean> {
  const { taskId, state: prev } = await conversationContext(id);
  const now = new Date();
  const result = await withTaskStatusChange(taskId ?? [], db, async () =>
    db
      .update(_conversations)
      .set({
        status: "gone",
        endedAt: now,
        waitingFor: null,
        workingOn: null,
        statusUnverifiedSince: null,
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
    await emitConversationStatusChange(id, taskId, prev, {
      status: "gone",
      waitingFor: null,
    });
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
  const { taskId, state: prev } = await conversationContext(id);
  await withTaskStatusChange(taskId ?? [], db, async () => {
    await db
      .update(_conversations)
      .set({
        status: "done",
        endedAt,
        workingOn: null,
        statusUnverifiedSince: null,
      })
      .where(eq(_conversations.id, id));
  });
  // Closing leaves `waitingFor` as it was.
  await emitConversationStatusChange(id, taskId, prev, {
    status: "done",
    waitingFor: prev?.waitingFor ?? null,
  });
}
