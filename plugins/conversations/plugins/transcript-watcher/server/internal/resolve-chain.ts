import { listSessionChain } from "@plugins/conversations/plugins/session-chain/server";
import { getConversationTranscriptTail } from "@plugins/tasks/plugins/tasks-core/server";
import {
  transcriptChainOf,
  type TranscriptChain,
} from "@plugins/conversations/plugins/transcript-source/core";
import { findTranscriptPath } from "./find-transcript-path";

/**
 * The on-disk transcript files backing a conversation, oldest → newest.
 *
 * Composes the two halves the callers used to wire by hand: the recorded session
 * chain (`session-chain`, which knows nothing about files) and the per-session
 * lookup (`findTranscriptPath`, which knows nothing about conversations).
 *
 * An **empty array is a legitimate value**: no session recorded yet, or Claude
 * has not written the transcript for a just-observed session id (the status reconciler
 * records the id before the file lands). A chain entry whose file is missing is
 * dropped, preserving the order of the rest. Every other failure — a DB error,
 * a permission error — THROWS.
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
 */
export async function resolveConversationTranscriptPaths(
  conversationId: string,
): Promise<string[]> {
  return resolveTranscriptPathsOf(await readTranscriptChain(conversationId));
}

/** The chain's facts, read from Postgres (see `resolveConversationTranscriptPaths`). */
async function readTranscriptChain(
  conversationId: string,
): Promise<TranscriptChain> {
  const [sessions, tail] = await Promise.all([
    listSessionChain(conversationId),
    // `undefined` = no such conversation; a `null` id = no session yet.
    getConversationTranscriptTail(conversationId),
  ]);
  return transcriptChainOf(sessions, tail, tail?.worktreePath);
}

/**
 * The files a chain's session ids name, oldest → newest — from the filesystem
 * ALONE: each id is looked up in the projects dir the chain's `cwd` names, so
 * a chain entry from another conversation (another worktree) names nothing
 * and is dropped like a GC'd one — it can neither be merged into the
 * transcript nor become the write tail `rewindLastUserTurn` truncates. The
 * read every live value resolves its followed chain through;
 * `resolveConversationTranscriptPaths` is it over the chain read from
 * Postgres.
 */
export async function resolveTranscriptPathsOf(
  chain: TranscriptChain,
): Promise<string[]> {
  const { cwd } = chain;
  if (cwd === null) return [];
  const paths = await Promise.all(
    chain.sessionIds.map((sessionId) => findTranscriptPath(cwd, sessionId)),
  );
  return paths.filter((path) => path !== null);
}
