import { eq, inArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db } from "@plugins/database/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { isHostSingleton } from "@plugins/infra/plugins/paths/server";
import { onTranscriptWritten } from "@plugins/conversations/plugins/transcript-watcher/server";
import { _conversationSessions } from "@plugins/conversations/plugins/session-chain/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { requestUsageSync } from "./sync";
import { requestSessionSync } from "./session-sync";

/**
 * The existing conversations a batch of written session ids belongs to, each
 * with the ids of the batch that are its own: every chain that recorded one
 * (joined to its conversation — a chain outlives a deleted one), plus every
 * conversation whose live tail is one (the chain is an enrichment of that
 * floor, see `resolveConversationTranscriptPaths`). ONE round trip, both arms
 * indexed on the session id; it is also the existence check the sync relies on.
 */
async function conversationsFor(
  sessionIds: string[],
): Promise<Map<string, Set<string>>> {
  const tails = db
    .select({
      conversationId: _conversations.id,
      sessionId: _conversations.claudeSessionId,
    })
    .from(_conversations)
    .where(inArray(_conversations.claudeSessionId, sessionIds));
  const chained = db
    .select({
      conversationId: _conversationSessions.conversationId,
      sessionId: _conversationSessions.claudeSessionId,
    })
    .from(_conversationSessions)
    .innerJoin(
      _conversations,
      eq(_conversations.id, _conversationSessions.conversationId),
    )
    .where(inArray(_conversationSessions.claudeSessionId, sessionIds));
  const out = new Map<string, Set<string>>();
  for (const { conversationId, sessionId } of await union(tails, chained)) {
    // Never null: both arms match it against `sessionIds`.
    if (sessionId === null) throw new Error("unreachable: null session id");
    const ids = out.get(conversationId) ?? new Set<string>();
    ids.add(sessionId);
    out.set(conversationId, ids);
  }
  return out;
}

/**
 * Sync what a batch of transcript writes touched: each conversation owning a
 * written session (its own sync), and every written session no existing
 * conversation owns (the ledger-only path, `session-sync.ts` — which also
 * skips a session a deleted conversation once ran, from its chain rows).
 */
async function syncWritten(
  written: ReadonlyMap<string, string>,
): Promise<void> {
  const owners = await conversationsFor([...written.keys()]);
  const owned = new Set([...owners.values()].flatMap((ids) => [...ids]));
  await Promise.all([
    ...[...owners].map(([id, ids]) => requestUsageSync(id, ids)),
    ...[...written]
      .filter(([sessionId]) => !owned.has(sessionId))
      .map(([sessionId, path]) => requestSessionSync(sessionId, path, "live")),
  ]);
}

let stop: (() => void) | null = null;

/**
 * Keep usage live: every write to a session or sub-agent transcript re-syncs
 * the conversation it belongs to (an append read of the new bytes) — or, for a
 * session no conversation owns, its ledger-only count. A price change needs
 * nothing here: the ledger holds tokens, priced at read.
 *
 * On the host singleton only (main in dev, the one backend in a release):
 * every backend hears every transcript write, and N worktree backends
 * re-reading the same appends into their own forked databases would multiply
 * the work for copies nobody is watching. A worktree keeps its fork's numbers
 * plus its own boot backfill.
 */
export function startLiveUsage(): void {
  if (!isHostSingleton() || stop !== null) return;
  const offWrites = onTranscriptWritten((written) => {
    void runTracked("conversations.usage:sync", () => syncWritten(written));
  });
  stop = offWrites;
}

export function stopLiveUsage(): void {
  stop?.();
  stop = null;
}
