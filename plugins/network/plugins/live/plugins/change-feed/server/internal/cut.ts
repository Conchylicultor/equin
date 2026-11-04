import { sql } from "drizzle-orm";
import { db, snapshotWatermark } from "@plugins/database/server";
import { awaitFeedBarrier } from "./listener";
import { BARRIER_CHANNEL } from "./txn-end";

// How long a cut waits for its own barrier. Delivery is one round trip on an
// idle LISTEN socket; past this the socket is stalled and the cut is refused.
const FEED_CUT_DEADLINE_MS = 1_500;

/** A routed-through cut of the change feed — see `feedCut`. */
export interface FeedCut {
  /**
   * The snapshot watermark (xid8 as decimal text) captured before the barrier:
   * every transaction with an xid below it had committed or aborted, and this
   * process has ROUTED every change of the committed ones.
   */
  cutXid: string;
}

/**
 * A feed cut: when it resolves, every change of every transaction with an xid
 * below `cutXid` has gone through this process's router (`routeChange`, which
 * is synchronous — so whatever pending a change makes exists). A transaction
 * at or above `cutXid` may or may not have been routed; its changelog row is
 * what a consumer replays (`xid >= cutXid`), so over-replay is the only
 * imprecision, and it is safe.
 *
 * Why it holds: `cutXid` is captured first, so every transaction below it
 * committed (or aborted) before the barrier NOTIFY's own commit. Postgres
 * delivers a listening session's notifications in commit order, so their
 * changes AND their end markers reach the socket before the barrier; on the
 * barrier the listener routes everything its burst router still holds
 * (`BurstRouter.drain`), then answers. Refused (it throws) with no LISTEN
 * session, on a session lost while waiting, and past the deadline — a cut
 * that cannot be proven is never reported as one.
 */
export const feedCut: () => Promise<FeedCut> = createFeedCut({
  watermark: () => snapshotWatermark(db),
  barrier: awaitFeedBarrier,
  notify: async (token) => {
    await db.execute(sql`SELECT pg_notify(${BARRIER_CHANNEL}, ${token})`);
  },
  deadlineMs: FEED_CUT_DEADLINE_MS,
});

/** What a feed cut runs on — injected so a suite can stall the NOTIFY. */
export interface FeedCutDeps {
  watermark: () => Promise<string>;
  barrier: (token: string, deadlineMs: number) => Promise<void>;
  notify: (token: string) => Promise<void>;
  deadlineMs: number;
}

export function createFeedCut(deps: FeedCutDeps): () => Promise<FeedCut> {
  return async () => {
    const cutXid = await deps.watermark();
    const token = `cut-${globalThis.crypto.randomUUID()}`;
    // Registered before the NOTIFY commits, so its delivery cannot be missed;
    // awaited together with it, so a deadline that passes while the NOTIFY is
    // still pending rejects THIS call instead of escaping as unhandled.
    const arrived = deps.barrier(token, deps.deadlineMs);
    await Promise.all([deps.notify(token), arrived]);
    return { cutXid };
  };
}
