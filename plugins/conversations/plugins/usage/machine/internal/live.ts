import { inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { isHostSingleton } from "@plugins/infra/plugins/paths/server";
import { onTranscriptWritten } from "@plugins/conversations/plugins/transcript-watcher/server";
import { listConversationsForSessions } from "@plugins/conversations/plugins/session-chain/server";
import { onPriceTableUpdated } from "@plugins/stats/plugins/cost/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { requestUsageSync } from "./sync";
import { usageRepriceJob } from "./jobs";

/**
 * The conversations a batch of written session ids belongs to: every chain
 * that recorded one, plus every conversation whose live tail is one (the chain
 * is an enrichment of that floor, see `resolveConversationTranscriptPaths`).
 * Both lookups are indexed on the session id.
 */
async function conversationsFor(sessionIds: string[]): Promise<Set<string>> {
  const tails = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(inArray(_conversations.claudeSessionId, sessionIds));
  return new Set([
    ...(await listConversationsForSessions(sessionIds)),
    ...tails.map((r) => r.id),
  ]);
}

async function syncWritten(sessionIds: string[]): Promise<void> {
  const ids = await conversationsFor(sessionIds);
  await Promise.all([...ids].map((id) => requestUsageSync(id)));
}

let stop: (() => void) | null = null;

/**
 * Keep usage live: every write to a session or sub-agent transcript re-syncs
 * the conversation it belongs to (an append read of the new bytes), and a
 * price-table refresh re-prices them all.
 *
 * On the host singleton only (main in dev, the one backend in a release):
 * every backend hears every transcript write, and N worktree backends
 * re-reading the same appends into their own forked databases would multiply
 * the work for copies nobody is watching. A worktree keeps its fork's numbers
 * plus its own boot backfill.
 */
export function startLiveUsage(): void {
  if (!isHostSingleton() || stop !== null) return;
  const offWrites = onTranscriptWritten((sessionIds) => {
    void runTracked("conversations.usage:sync", () =>
      syncWritten([...sessionIds]),
    );
  });
  const offPrices = onPriceTableUpdated(() => {
    void usageRepriceJob.enqueue({});
  });
  stop = () => {
    offWrites();
    offPrices();
  };
}

export function stopLiveUsage(): void {
  stop?.();
  stop = null;
}
