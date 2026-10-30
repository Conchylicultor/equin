// In-process signal: the ledger's evidence for a conversation's status moved —
// the CLI confirmed submitting a turn, or a turn entered or left a pending
// state (`conversationsWithPendingTurn`). The status reconciler listens, so the
// `working` it derives from the ledger is written on the change's own arrival —
// push, not the next sweep. Same shape as transcript-watcher's
// `onSessionTranscriptWritten`.

type Listener = (conversationId: string) => void;

const listeners = new Set<Listener>();

/** Subscribe to status-evidence changes; returns the unsubscribe. */
export function onStatusEvidence(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyStatusEvidence(conversationId: string): void {
  for (const listener of listeners) listener(conversationId);
}
