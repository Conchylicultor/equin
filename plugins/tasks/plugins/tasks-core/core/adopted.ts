/**
 * The `spawnedBy` of a conversation main ADOPTED: a live tmux session the
 * retired tmux runtime found running with no conversation row. Nothing
 * launched it on purpose, so the queue shows it in its own Lost section rather
 * than ranking it among the user's work. Nothing adopts any more; the rows it
 * made keep the value ("poller", from the 1 s poller that adopted first).
 */
const ADOPTED_SPAWNED_BY = "poller";

/** Was this conversation adopted (see {@link ADOPTED_SPAWNED_BY})? */
export function isAdoptedConversation(conv: {
  spawnedBy: string | null;
}): boolean {
  return conv.spawnedBy === ADOPTED_SPAWNED_BY;
}
