import { asc, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { db, type DbExecutor } from "@plugins/database/server";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { sessionLinkIdKind } from "../../core";
import { _conversationSessions } from "./tables";

/** One link of a conversation's session chain. */
export interface SessionChainEntry {
  claudeSessionId: string;
  seenAt: Date;
}

/**
 * Append `claudeSessionId` to the conversation's chain, unless it is already the
 * tail. Called from the status reconciler on every reconcile that adopts an id, so the steady state — the tail is
 * already this id — must cost one indexed row read and no write.
 *
 * Append-only: never UPDATEs, never DELETEs.
 *
 * Race safety is CONSTRAINT-based, not read-then-write: the tail probe is a
 * cheap fast path, and the insert is guarded by the UNIQUE (conversation_id,
 * claude_session_id) index via ON CONFLICT DO NOTHING. Two ticks (or two
 * processes) that both observe the same new id therefore cannot both append —
 * the loser writes nothing rather than racing on a stale read. This also means
 * a session id that flaps away and back never re-enters the chain: its position
 * stays pinned at first-seen, which is what the transcript merge wants (first
 * occurrence wins, original timestamps survive).
 *
 * `conn` is injectable so DB-backed tests can drive a throwaway database, and
 * so the reconciler appends inside the transaction that writes the tail.
 */
export async function recordSessionId(
  conversationId: string,
  claudeSessionId: string,
  conn: DbExecutor = db,
): Promise<void> {
  const [tail] = await conn
    .select({ claudeSessionId: _conversationSessions.claudeSessionId })
    .from(_conversationSessions)
    .where(eq(_conversationSessions.conversationId, conversationId))
    .orderBy(desc(_conversationSessions.seenAt))
    .limit(1);

  if (tail?.claudeSessionId === claudeSessionId) return;

  await conn
    .insert(_conversationSessions)
    .values({ id: sessionLinkIdKind.mint(), conversationId, claudeSessionId })
    .onConflictDoNothing({
      target: [
        _conversationSessions.conversationId,
        _conversationSessions.claudeSessionId,
      ],
    });
}

/**
 * The conversation's session chain, oldest → newest. An empty array is a
 * legitimate answer (no session observed yet), not an absorbed failure: a DB
 * error propagates.
 */
export async function listSessionChain(
  conversationId: string,
  conn: NodePgDatabase = db,
): Promise<SessionChainEntry[]> {
  return await conn
    .select({
      claudeSessionId: _conversationSessions.claudeSessionId,
      seenAt: _conversationSessions.seenAt,
    })
    .from(_conversationSessions)
    .where(eq(_conversationSessions.conversationId, conversationId))
    .orderBy(asc(_conversationSessions.seenAt));
}

/** One Claude session id recorded on more than one conversation. */
export interface SharedSessionId {
  claudeSessionId: string;
  /** Every conversation whose chain holds it — always at least two, sorted. */
  conversationIds: string[];
}

/**
 * Every `claude_session_id` that appears in MORE THAN ONE conversation's chain.
 *
 * A Claude session belongs to exactly one conversation, so any row here is
 * corruption: two conversations recorded the same id, and at most one of them
 * really ran it. The `UNIQUE (conversation_id, claude_session_id)` index makes a
 * chain internally consistent, but says nothing across conversations — which is
 * exactly the gap the 2026-08-19 cross-talk incident fell through (a lent
 * background spare's id was adopted by the pane hosting the daemon, 0.5 s after
 * its real owner recorded it).
 *
 * Pure SQL, deliberately. It touches no filesystem and no process table, so it
 * sees a **hibernated** conversation whose pane is long gone and whose
 * transcripts have been swept — the cases every other detector in this area is
 * structurally blind to. It also assumes nothing about how Claude encodes a cwd
 * into a projects directory, so it cannot be defeated by that encoding changing.
 *
 * An empty array is the healthy answer, not an absorbed failure: a DB error
 * propagates. `conn` is injectable so a DB-backed test can drive a throwaway
 * database.
 */
export async function listSharedClaudeSessionIds(
  conn: NodePgDatabase = db,
): Promise<SharedSessionId[]> {
  return await conn
    .select({
      claudeSessionId: _conversationSessions.claudeSessionId,
      conversationIds:
        sql`array_agg(DISTINCT ${_conversationSessions.conversationId} ORDER BY ${_conversationSessions.conversationId})`.mapWith(
          parsed(z.array(z.string()), "sharedClaudeSessionIds.conversationIds"),
        ),
    })
    .from(_conversationSessions)
    .groupBy(_conversationSessions.claudeSessionId)
    .having(sql`count(DISTINCT ${_conversationSessions.conversationId}) > 1`)
    .orderBy(asc(_conversationSessions.claudeSessionId));
}
