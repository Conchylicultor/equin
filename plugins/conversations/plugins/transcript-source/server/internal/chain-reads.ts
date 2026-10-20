import { _conversationSessions } from "@plugins/conversations/plugins/session-chain/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import type { ValueReads } from "@plugins/infra/plugins/query-resource/server";

/**
 * The Postgres reads of `resolveConversationTranscriptPaths` (transcript-watcher),
 * declared once: every served value whose loader resolves a
 * conversation's transcript chain passes this as its `reads`, so a write to
 * either table routes a recompute of its open tuples.
 *
 * Both tables, even though `conversations` is read only on the empty-chain
 * fallback: a conversation with no recorded session takes that arm, and a
 * declaration missing it would drift on exactly those tuples.
 */
export const transcriptChainReads = {
  tables: [_conversationSessions, _conversations],
  reason:
    "Resolves the conversation's transcript files from its recorded session chain (conversation_sessions), falling back to conversations.claude_session_id while the chain is empty — a write to either can change which files the value is read from.",
} satisfies ValueReads;
