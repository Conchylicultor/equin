import type { TxnEnd } from "./parse-payload";
import type { FeedChange } from "./route-change";

// Route one transaction's NOTIFYs as ONE burst, once the transaction says it is
// done.
//
// Why: a transaction writing N tables emits N NOTIFYs, delivered together at
// commit — but the socket may hand them over across several reads, and the
// runtime drains on the next MICROTASK after the first one routes. A drain that
// runs between two of them sends that transaction's ack (`ackTx`) — a standalone
// ack for a tuple the first change skipped, or a scoped refill's frame — before
// its other change has reached the same tuple, so an optimistic client confirms
// an op whose row it has not been sent yet and briefly reverts it.
//
// The fix is exact, not a timing bet: every transaction that writes the feed
// ends with a marker — `live_state_txn_end()`, a deferred constraint trigger on
// the changelog, sends `live_state_end {x, n}` at commit, after every statement
// (`triggers.ts`). All channels share one notification queue, so it arrives
// after the transaction's last change whatever the socket reads. A change
// carrying an xid is HELD under it; on the xid's end its changes move, in
// arrival order, to the ready queue, which routes from one macrotask — every
// change of the transaction lands in the same pendings, so its ack leaves only
// after all of them did (the runtime folds one tuple's changes into one pending,
// and a skipped tuple's owed ack into its real pending). A change with no xid (a
// NOTIFY from no transaction we know) routes from the next macrotask, as before
// the marker existed. (The reconnect `fullSweep` and the change producers do not
// come through here: they route directly and carry no xid to ack.)
//
// Nothing is ever dropped. A broken assumption is reported, then routed:
//
//  - `change-after-end` — a change for an xid whose end already arrived (a
//    `SET CONSTRAINTS ALL IMMEDIATE` fires the marker early): the ack went out
//    before this change;
//  - `over-count` — more changes than the end's `n` (Postgres delivers one of
//    several identical payloads, so `n` is an upper bound, never exceeded);
//  - `interleaved` — a new xid's change while an older xid is open: one
//    transaction's notifications are contiguous, so the older one's end is not
//    coming next. The older one is released;
//  - `txn-end-missing` — an xid that received nothing for its deadline (one
//    one-shot timer per open xid, not a poll — re-armed for the remainder when a
//    change arrived meanwhile, so a long burst still streaming in is never cut
//    off at its first change's deadline). It is released.
//
// After `close()` (listener stop, or a socket retired mid-transaction — its end
// can never arrive on a new socket, whose reconnect sweep covers the gap) the
// router holds nothing: every later change routes from the next macrotask.
//
// A pure factory: routing, reporting, the macrotask and the deadline timer are
// injected, so a test drives every case by hand.

/** A broken end-of-transaction assumption, reported before the changes route. */
export type TxnEndProblem =
  | { kind: "change-after-end"; xid: string; table: string }
  | { kind: "over-count"; xid: string; routed: number; n: number }
  | { kind: "interleaved"; xid: string; next: string; held: number }
  | { kind: "txn-end-missing"; xid: string; held: number; ms: number };

/** How long an xid may stay open before its changes are released without an end. */
export const TXN_END_DEADLINE_MS = 2_000;

// How many ended / released xids are remembered, to recognise a change or an
// end arriving after them. One transaction's notifications are contiguous, so
// anything legitimately late is very recent; the bound only keeps memory flat.
const REMEMBERED_XIDS = 1_024;

export interface BurstRouterOptions {
  route: (change: FeedChange) => void;
  report: (problem: TxnEndProblem) => void;
  /** Run `fn` on a later macrotask (default `setImmediate`). */
  defer?: (fn: () => void) => void;
  /** Arm a one-shot timer; returns its cancel (default: an unref'd `setTimeout`). */
  arm?: (fn: () => void, ms: number) => () => void;
  /** A monotonic clock in ms (default `performance.now`). */
  now?: () => number;
  deadlineMs?: number;
}

export interface BurstRouter {
  /** A parsed `live_state` NOTIFY. */
  change(change: FeedChange): void;
  /** A parsed `live_state_end` NOTIFY. */
  end(end: TxnEnd): void;
  /**
   * Release the open xid, cancelling its deadline, and hold nothing from now
   * on (listener stop or socket retire). Never reported: a retired socket's end
   * cannot arrive.
   */
  close(): void;
  /** Hold again after `close()` (a new socket is listening). */
  reopen(): void;
}

function armUnref(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  // The deadline never keeps a stopping process alive.
  timer.unref();
  return () => clearTimeout(timer);
}

// Insertion-ordered, oldest evicted first.
function remember<V>(map: Map<string, V>, xid: string, value: V): void {
  map.delete(xid);
  map.set(xid, value);
  if (map.size > REMEMBERED_XIDS) {
    map.delete(map.keys().next().value!);
  }
}

interface OpenXid {
  xid: string;
  held: FeedChange[];
  cancel: () => void;
  // When its last change arrived: the deadline runs from it.
  lastAt: number;
}

export function createBurstRouter(opts: BurstRouterOptions): BurstRouter {
  const { route, report } = opts;
  const defer = opts.defer ?? setImmediate;
  const arm = opts.arm ?? armUnref;
  const deadlineMs = opts.deadlineMs ?? TXN_END_DEADLINE_MS;
  const now = opts.now ?? (() => performance.now());
  let closed = false;

  let ready: FeedChange[] = [];
  let armed = false;
  // The transaction whose changes are being held — at most one, since one
  // transaction's notifications are contiguous.
  let open: OpenXid | null = null;
  // Xids whose changes were released before their end: how many arrived.
  const released = new Map<string, number>();
  const ended = new Map<string, true>();

  const flush = (): void => {
    armed = false;
    const changes = ready;
    ready = [];
    for (const change of changes) route(change);
  };

  function enqueue(changes: readonly FeedChange[]): void {
    ready.push(...changes);
    if (armed) return;
    armed = true;
    defer(flush);
  }

  function release(o: OpenXid): void {
    o.cancel();
    open = null;
    remember(released, o.xid, o.held.length);
    enqueue(o.held);
  }

  function openXid(change: FeedChange, xid: string): void {
    const o: OpenXid = { xid, held: [change], cancel: () => {}, lastAt: now() };
    const expire = (): void => {
      if (open !== o) return;
      const quiet = now() - o.lastAt;
      if (quiet < deadlineMs) {
        // Changes kept arriving: wait out the remainder from the last one.
        o.cancel = arm(expire, deadlineMs - quiet);
        return;
      }
      // Give the socket one more turn first: after a stalled event loop the
      // timer phase runs before the poll phase reads the end already waiting.
      defer(() => {
        if (open !== o) return;
        report({
          kind: "txn-end-missing",
          xid,
          held: o.held.length,
          ms: deadlineMs,
        });
        release(o);
      });
    };
    o.cancel = arm(expire, deadlineMs);
    open = o;
  }

  return {
    change(change) {
      const xid = change.xid;
      if (xid === undefined || closed) {
        enqueue([change]);
        return;
      }
      if (open?.xid === xid) {
        open.held.push(change);
        open.lastAt = now();
        return;
      }
      if (ended.has(xid)) {
        report({ kind: "change-after-end", xid, table: change.table });
        enqueue([change]);
        return;
      }
      const seen = released.get(xid);
      if (seen !== undefined) {
        // Already reported when it was released; its end still checks `n`.
        released.set(xid, seen + 1);
        enqueue([change]);
        return;
      }
      if (open) {
        report({
          kind: "interleaved",
          xid: open.xid,
          next: xid,
          held: open.held.length,
        });
        release(open);
      }
      openXid(change, xid);
    },

    end({ xid, n }) {
      let routed: number;
      if (open?.xid === xid) {
        const o = open;
        routed = o.held.length;
        o.cancel();
        open = null;
        enqueue(o.held);
      } else {
        routed = released.get(xid) ?? 0;
        released.delete(xid);
      }
      if (routed > n) report({ kind: "over-count", xid, routed, n });
      remember(ended, xid, true);
    },

    close() {
      closed = true;
      if (open) release(open);
    },

    reopen() {
      closed = false;
    },
  };
}
