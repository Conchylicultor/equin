import { listSessionChain } from "@plugins/conversations/plugins/session-chain/server";
import { getConversationClaudeSessionId } from "@plugins/tasks/plugins/tasks-core/server";
import {
  transcriptChainOf,
  type TranscriptChain,
} from "@plugins/conversations/plugins/transcript-source/core";
import { resolveAnchoredChain } from "./anchor";
import { reportForeignSession } from "./foreign-session-report";

/**
 * The on-disk transcript files backing a conversation, oldest → newest.
 *
 * Composes the two halves the callers used to wire by hand: the recorded session
 * chain (`session-chain`, which knows nothing about files) and the projects-dir
 * glob (`findTranscriptPath`, which knows nothing about conversations).
 *
 * An **empty array is a legitimate value**: no session recorded yet, or Claude
 * has not written the transcript for a just-observed session id (the status reconciler
 * records the id before the file lands). A chain entry whose file is missing is
 * dropped, preserving the order of the rest. Every other failure — a DB error,
 * a glob/permission error — THROWS.
 *
 * That distinction is the point. The six call sites this replaces each did
 * `getConversationClaudeSessionId` → `findTranscriptPath` → `return []`, so a
 * dead database and an empty conversation produced the same rendered answer.
 *
 * The chain ENRICHES a guaranteed floor, it is not the sole source of truth:
 * `conversations.claude_session_id` stands in while it is empty
 * (`transcriptChainOf`, transcript-source core — the one place that rule lives).
 * That keeps a conversation the status reconciler never revisited readable,
 * makes the backfill migration a recovery of *history* rather than a
 * prerequisite for rendering anything at all, and means a chain wiped by hand
 * degrades to single-file behaviour instead of a blank pane.
 *
 * Reads the chain's facts from Postgres itself — for a caller outside any live
 * value (rewind, backup, retention, the watcher's own rooms). A served value
 * follows them instead (`transcriptChainFollows`) and resolves the files with
 * `resolveTranscriptPathsOf`, so the DB read is routed per conversation.
 *
 * **A chain entry from another conversation is dropped, not merged.**
 * `resolveAnchoredChain` anchors the conversation to the projects dir of its
 * first resolvable session and refuses everything resolving elsewhere. A foreign
 * entry that survived to here would be merged into the rendered transcript, and
 * — worse — could be `paths.at(-1)`, which is what `rewindLastUserTurn`
 * truncates: the Stop button would destroy another agent's live transcript. Each
 * refusal is reported (debounced), because the DB row stays wrong until somebody
 * removes it. See `research/2026-08-19-global-pane-session-ownership.md`.
 */
export async function resolveConversationTranscriptPaths(
  conversationId: string,
): Promise<string[]> {
  return resolveTranscriptPathsOf(
    conversationId,
    await readTranscriptChain(conversationId),
  );
}

/** The chain's facts, read from Postgres (see `resolveConversationTranscriptPaths`). */
async function readTranscriptChain(
  conversationId: string,
): Promise<TranscriptChain> {
  const [sessions, tail] = await Promise.all([
    listSessionChain(conversationId),
    // `undefined` = no such conversation; `null` = row exists, no session yet.
    getConversationClaudeSessionId(conversationId),
  ]);
  return transcriptChainOf(
    sessions,
    tail === undefined ? undefined : { claudeSessionId: tail },
  );
}

/**
 * The files a chain's session ids name, oldest → newest — from the
 * filesystem ALONE (the projects-dir glob, anchored to the conversation's own
 * directory; a foreign entry dropped and reported). The read every live value
 * resolves its followed chain through; `resolveConversationTranscriptPaths`
 * is it over the chain read from Postgres.
 */
export async function resolveTranscriptPathsOf(
  conversationId: string,
  chain: TranscriptChain,
): Promise<string[]> {
  const { anchorDir, kept, foreign } = await resolveAnchoredChain(
    chain.sessionIds,
  );

  // `foreign` is empty whenever nothing anchored, so this guard never actually
  // skips a report — it is how the compiler sees that `anchorDir` is a string
  // inside the loop, rather than a runtime branch.
  if (anchorDir !== null) {
    for (const entry of foreign) {
      reportForeignSession({
        reason: "directory-mismatch",
        conversationId,
        foreignSessionId: entry.sessionId,
        foreignDir: entry.dir,
        anchorDir,
      });
    }
  }

  return kept.map((entry) => entry.path);
}
