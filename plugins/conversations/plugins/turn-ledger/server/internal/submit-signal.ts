// In-process signal: the CLI just confirmed submitting a turn (a hook matched a
// ledger row). The status reconciler listens, so the `working` it derives from
// `submitted_at` is written on the hook's own arrival — push, not the next
// sweep. Same shape as transcript-watcher's `onSessionTranscriptWritten`.

type Listener = (conversationId: string) => void;

const listeners = new Set<Listener>();

/** Subscribe to confirmed submits; returns the unsubscribe. */
export function onTurnSubmitted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyTurnSubmitted(conversationId: string): void {
  for (const listener of listeners) listener(conversationId);
}
