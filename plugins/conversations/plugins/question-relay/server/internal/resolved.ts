import type { RelayResolution } from "../../core/schemas";

// The in-process side of a question being answered: the agent that holds the
// question (the sdk runtime's `canUseTool`) listens here. The answer endpoint
// notifies, once, after its row is written.

export interface ResolvedQuestion {
  conversationId: string;
  toolUseId: string;
  resolution: Exclude<RelayResolution, { state: "open" }>;
}

type Listener = (q: ResolvedQuestion) => void | Promise<void>;
const listeners = new Set<Listener>();

/**
 * Call `cb` every time a held question leaves `open`. Returns the unsubscribe.
 * A listener that throws is reported by the caller's request (the answer
 * endpoint), so a delivery failure is never silent.
 */
export function onQuestionResolved(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function notifyQuestionResolved(
  q: ResolvedQuestion,
): Promise<void> {
  for (const cb of [...listeners]) await cb(q);
}
