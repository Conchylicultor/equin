import type { RelayResolution } from "../../core/schemas";

// The in-process side of a question being resolved: the hook's long poll is
// woken through `waiters.ts`; an agent that holds the question in-process (the
// sdk runtime's `canUseTool`) listens here instead. Every settle (answer,
// release, abandon) notifies, once, after its row is written.

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
