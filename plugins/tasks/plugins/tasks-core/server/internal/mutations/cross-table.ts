import { db } from "@plugins/database/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import { _attempts, _tasks } from "../tables";
import { conversations } from "../views";
import type { Conversation } from "../schema";
import { eq } from "drizzle-orm";
import { findNextRankInFolder } from "../queries/tasks";
import { listActiveConversations } from "../queries/conversations";
import { insertConversationRow } from "./conversations";
import { updateTask } from "./tasks";
import type { DbExecutor } from "../status-batch";
import type { WorkspaceSpec } from "@plugins/conversations/plugins/workspace/core";
import { ADOPTED_SPAWNED_BY } from "../../../core/adopted";
import { taskIdKind } from "@plugins/tasks/plugins/task-ids/core";

// ONE HALF of the exit-drop policy, and named for exactly the half it is: does
// any sibling conversation on this task remain active? If one does, another
// conversation may still land the work, so this closing one must not drop the
// task. The closing conversation is excluded by id, so callers may invoke this
// either before or after marking it closed.
//
// The other half — "does this attempt have work at stake?" — deliberately does
// NOT live here. It used to: this function read `listPushesForAttempt` and
// treated an empty result as proof that nothing was pushed, which was false
// whenever the ledger's background ingest lagged (observed 40+ minutes behind a
// wedged queue) and is still false for an attempt whose commits are not pushed
// yet. An agent that pushed and then exited cleanly got its task dropped. That fact is now git-measured by `tasks/attempt-work`, and the whole
// policy lives in the plugin named for it, `conversation-view/drop-and-exit`,
// as `dropTaskOnExit` — the only thing callers should reach for. tasks-core has
// no business guessing at an attempt's standing, and an honest name here cannot
// be mistaken for the whole policy.
// Design: research/2026-08-17-global-attempt-work-git-derived-standing.md.
//
// Returns whether the task was dropped.
export async function dropTaskIfNoActiveSibling(
  conversation: Conversation,
): Promise<boolean> {
  const activeConversations = await listActiveConversations();
  const hasOtherActive = activeConversations.some(
    (c) => c.taskId === conversation.taskId && c.id !== conversation.id,
  );

  if (hasOtherActive) return false;
  await updateTask(conversation.taskId, { drop: true });
  return true;
}

export interface AdoptOrphanInput {
  id: string;
  /**
   * The session's workspace, resolved by the caller from its cwd
   * (conversations/workspace's `Workspace.resolvePath`): `path ===
   * Workspace.pathFor(kind, attemptId)`, the invariant the rest of the system
   * relies on (e.g. the "Open app" button). A cwd that is no workspace is not
   * adopted at all — never handed here. `spec` is what a synthesized attempt
   * records, or null when the kind cannot be described from the path alone (a
   * scratch profile lives only on its attempt row): then only an existing
   * attempt is linked.
   */
  workspace: {
    attemptId: string;
    path: string;
    spec: WorkspaceSpec | null;
  };
  runtimeId: string;
  status: "starting" | "working" | "waiting" | "gone" | "done";
  title?: string | null;
  /**
   * The version recorded for the adopted row. What a stray session runs is not
   * known; the caller resolves it (the default family's current version) so
   * this schema layer never reads the runtime model catalog.
   */
  model: ConversationModel;
  /**
   * Runs on the adoption's own transaction, only when this call inserted the
   * row — so whatever the caller announces (the `conversationCreated` emit, and
   * with it the queue rank, title generation, …) commits together with the row
   * or not at all. Required: an adopted conversation that skips it is a live
   * session the rest of the app never hears was created.
   */
  onAdopted: (
    tx: DbExecutor,
    adopted: { conversation: AdoptedRow; taskId: string },
  ) => Promise<void>;
}

type AdoptedRow = NonNullable<
  Awaited<ReturnType<typeof insertConversationRow>>
>;

// Synthesises a task + attempt + conversation row in a single transaction for
// a live tmux session that has no corresponding DB rows. Called by the status reconciler
// when it discovers an orphan session.
//
// `input.id` is forced to be the conversation id because the status reconciler matches
// live tmux sessions to DB rows by id (the tmux session name is fixed once
// spawned). The attempt id is the one the caller derived from the workspace
// path (see `AdoptOrphanInput.workspace`).

// Returns the adopted conversation row plus the id of the task this call
// synthesized (null when the conversation was linked to an existing attempt's
// task) — the caller stamps the new task's category, which lives in a plugin
// tasks-core cannot import.
export async function adoptOrphanConversation(input: AdoptOrphanInput) {
  const { attemptId, path: worktreePath, spec } = input.workspace;

  let inserted = false;
  let createdTaskId: string | null = null;
  const taskId = taskIdKind.mint();

  // The attempt may already exist (e.g. the conversation was originally
  // created on a worktree server, so the attempt row is in the main DB
  // but the conversation row is not). If so, link the new conversation
  // to the existing attempt instead of creating a new task+attempt chain.
  const [existing] = await db
    .select({ id: _attempts.id, taskId: _attempts.taskId })
    .from(_attempts)
    .where(eq(_attempts.id, attemptId))
    .limit(1);
  const link = existing
    ? { kind: "existing" as const, taskId: existing.taskId }
    : spec
      ? { kind: "new" as const, spec }
      : null;
  // Returning null = not adopted; the status reconciler treats this exactly
  // like any other un-adopted orphan and moves on.
  if (!link) return null;

  const conversationValues = {
    id: input.id,
    attemptId,
    runtime: input.runtimeId,
    status: input.status,
    title: input.title ?? null,
    spawnedBy: ADOPTED_SPAWNED_BY,
    model: input.model,
  };
  await db.transaction(async (tx) => {
    let rowTaskId: string;
    if (link.kind === "existing") {
      rowTaskId = link.taskId;
    } else {
      const rank = await findNextRankInFolder(null, tx);
      await tx.insert(_tasks).values({
        id: taskId,
        title: input.title?.trim() || "Untitled",
        rank: rank.toJSON(),
      });
      await tx.insert(_attempts).values({
        id: attemptId,
        taskId,
        worktreePath,
        workspace: link.spec,
      });
      rowTaskId = taskId;
    }
    const row = await insertConversationRow(tx, conversationValues, {
      ignoreConflict: true,
    });
    if (!row) return;
    inserted = true;
    if (link.kind === "new") createdTaskId = taskId;
    await input.onAdopted(tx, { conversation: row, taskId: rowTaskId });
  });
  if (!inserted) return null;
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.id))
    .limit(1);
  if (!row) return null;
  return { conversation: row, createdTaskId };
}
