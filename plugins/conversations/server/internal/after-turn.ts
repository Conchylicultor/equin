import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import {
  conversationTurnCompleted,
  type ConversationTurnCompletedPayload,
} from "./tables-turn-completed-event";

// Suspend the calling job until this conversation's next turn is over — an
// assistant `end_turn` its Stop hooks let stand — or `timeoutMs` elapses. Returns the payload, or null on
// timeout. Thin convention layer over `ctx.waitFor(conversationTurnCompleted)`
// so consumers don't re-derive the where-shape and so the "wait for the
// model to finish talking" intent is named.
export async function afterTurn(
  ctx: JobCtx,
  conversationId: string,
  opts?: { timeoutMs?: number; name?: string },
): Promise<ConversationTurnCompletedPayload | null> {
  return ctx.waitFor<ConversationTurnCompletedPayload>(conversationTurnCompleted, {
    where: { conversationId },
    timeoutMs: opts?.timeoutMs,
    name: opts?.name,
  });
}
