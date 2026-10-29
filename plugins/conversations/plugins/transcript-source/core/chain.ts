/**
 * A conversation's transcript chain as recorded FACTS: the Claude session ids
 * its transcript is read from, oldest → newest. Which files those ids name is
 * the host's business (on the desktop, a projects-dir glob anchored to the
 * conversation's own directory — transcript-watcher's
 * `resolveTranscriptPathsOf`); the ids themselves come from Postgres, read by
 * a live value through its `follows` (transcript-source's
 * `transcriptChainFollows`) or by a plain caller from the tables directly.
 */
export interface TranscriptChain {
  readonly sessionIds: readonly string[];
}

/**
 * The chain from its two facts: the recorded session chain (the
 * `conversation_sessions` rows, oldest → newest) and the conversation's live
 * tail (`conversations.claude_session_id` — `undefined` for no such
 * conversation, a `null` id for one with no session yet).
 *
 * **The one place the fallback rule lives.** The recorded chain ENRICHES a
 * guaranteed floor rather than replacing it: the status reconciler appends to
 * the chain only when it observes a change on a live pane, so a conversation
 * it never revisits can hold a valid tail with no chain row. While the chain
 * is empty, the tail alone is the chain; once it holds anything, the chain is
 * the whole truth (its newest entry IS the tail, recorded).
 */
export function transcriptChainOf(
  sessions: readonly { readonly claudeSessionId: string }[],
  tail: { readonly claudeSessionId: string | null } | undefined,
): TranscriptChain {
  if (sessions.length > 0) {
    return { sessionIds: sessions.map((s) => s.claudeSessionId) };
  }
  const id = tail?.claudeSessionId;
  return { sessionIds: id ? [id] : [] };
}
