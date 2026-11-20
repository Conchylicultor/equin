import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import {
  getConversation,
  type Conversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import { isTurnRunning } from "../../core";
import {
  conversationTurnCompleted,
  type ConversationTurnCompletedPayload,
} from "./tables-turn-completed-event";

/** The row fields the recheck reads the turn's end from. */
export type TurnStateRow = Pick<
  Conversation,
  "status" | "workingOn" | "statusUnverifiedSince"
>;

/**
 * Whether the conversation's recorded state says no turn is running — the
 * turn the caller waits on is over. The reconciler moves the row off
 * `working`/`turn` only once the runtime reports the turn's `result`, which
 * comes after its Stop hooks let it stop, so this is the same end the
 * `conversation.turn-completed` event announces. A row whose status the
 * runtime cannot vouch for (`statusUnverifiedSince`) or that is still
 * `starting` is not over: the wait goes on and the event decides. A missing
 * row, or one whose agent is gone or closed, has no turn left to end.
 */
export function turnIsOver(row: TurnStateRow | null): boolean {
  if (row === null) return true;
  if (row.statusUnverifiedSince !== null) return false;
  if (row.status === "starting") return false;
  return !isTurnRunning(row);
}

/** {@link afterTurn} with the row read injected (tests). */
export async function waitAfterTurn(
  ctx: Pick<JobCtx, "waitFor">,
  conversationId: string,
  opts: { timeoutMs?: number; name?: string } | undefined,
  readRow: (id: string) => Promise<TurnStateRow | null>,
): Promise<ConversationTurnCompletedPayload | null> {
  return ctx.waitFor<ConversationTurnCompletedPayload>(
    conversationTurnCompleted,
    {
      where: { conversationId },
      timeoutMs: opts?.timeoutMs,
      name: opts?.name,
      // The turn may have ended before the trigger was armed (a finalize job
      // picked up after the agent's last end_turn): the row records it.
      settled: {
        recheck: async () => turnIsOver(await readRow(conversationId)),
      },
    },
  );
}

// Suspend the calling job until this conversation's current turn is over — an
// assistant `end_turn` its Stop hooks let stand — or `timeoutMs` elapses.
// Returns the payload, or null on timeout or when the turn was already over
// once the wait was armed (read from the conversation's recorded state). Thin
// convention layer over `ctx.waitFor(conversationTurnCompleted)` so consumers
// don't re-derive the where-shape and so the "wait for the model to finish
// talking" intent is named.
export async function afterTurn(
  ctx: JobCtx,
  conversationId: string,
  opts?: { timeoutMs?: number; name?: string },
): Promise<ConversationTurnCompletedPayload | null> {
  return waitAfterTurn(ctx, conversationId, opts, getConversation);
}
