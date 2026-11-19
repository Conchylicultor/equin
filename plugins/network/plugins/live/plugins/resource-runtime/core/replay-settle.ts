import { promiseWithResolvers } from "@plugins/packages/plugins/floor-compat/core";
// When the restart replay has been answered: the signal a serving host waits
// on before it starts its post-serving background work (server-core's settled
// phase — every warm-up drains there).
//
// A restart closes every tab's socket (the gateway retires the old backend's
// WebSockets the moment it swaps the successor in), and each tab reconnects
// and replays its whole sub set at once — thousands of reads through the
// read gates (`read-admit`, `read-spawn`) and the database. Background work
// started in the same seconds (warm-ups, backfills) takes the same gates,
// the same pool and the same event loop, and nobody waits on it; the tabs do
// wait on the replay. So the background starts once the replay has settled.
//
// A REPLAY REQUEST is a sub that echoes another boot's epoch (`sub` /
// `sub-batch` whose `epoch` is not this process's): a tab that was connected
// to an earlier process. A fresh tab sends none — it is interactive work like
// any later read, and never part of the replay.
//
// SETTLED, in order of precedence:
//   - `replayed`: every replay request received so far has been answered, and
//     no replay request arrived nor was answered for `quietMs` — the gap that
//     lets the other sockets of the herd land (they reconnect within ~1 s of
//     the swap: one 500 ms backoff);
//   - `no-replay`: no replay request arrived within `herdWaitMs` of arming —
//     no tab was connected to the predecessor (a worktree nobody has open, a
//     first boot). Arming happens at the ready barrier, which is when the
//     gateway swaps and closes the old sockets, so the herd is due at once;
//   - `ceiling`: `ceilingMs` after arming or the first replay request,
//     whichever came first, whatever is still owed. A bound around the tabs
//     (a peer this process does not control: one may never answer its
//     socket's backpressure), never the signal — the outcome says so, with
//     what was still owed. Starting it at the first request also bounds what
//     a host that never arms (central, a browser host) keeps.
//
// A request stops being owed when its answer frame left (`sub-ack`,
// `up-to-date`, `up-to-date-batch` entry, `sub-error`), when its socket closed
// (the tab replays again on its next socket), or when the runtime no longer
// owes its tab an answer for the tuple (`stillOwed` — an unsub, or a later
// request for the same tuple answered under its own id).
//
// One-shot per process: once settled, nothing is tracked any more.

/** The bounds of {@link createReplaySettle} — see the header. */
export interface ReplaySettleBounds {
  /** How long to wait, from arming, for the first replay request. */
  herdWaitMs: number;
  /** How long nothing may happen to the replay before it counts as settled. */
  quietMs: number;
  /** Settled anyway this long after arming or the first replay request. */
  ceilingMs: number;
}

// The deploy waits for `boot: "settled"`, which comes after this wait and the
// warm-up drain: a backend nobody has open (most agent worktrees) pays
// `herdWaitMs` on every build, and `ceilingMs` plus the drain must stay well
// inside the deploy's 60 s settle deadline. The herd lands within ~1 s of the
// swap (the gateway polls readiness every 100 ms, a tab reconnects after one
// 500 ms backoff), so a tab later than 3 s replays beside the warm-ups, as
// every tab did before.
export const REPLAY_SETTLE_BOUNDS: ReplaySettleBounds = {
  herdWaitMs: 3_000,
  quietMs: 2_000,
  ceilingMs: 30_000,
};

/** How the replay settled, and what it was. Times are ms after arming (or, unarmed, after the first replay request). */
export type ReplaySettled =
  | { kind: "no-replay"; afterMs: number }
  | {
      kind: "replayed";
      afterMs: number;
      /** Replay requests received. */
      requests: number;
      /** Sockets that sent one. */
      sockets: number;
    }
  | {
      kind: "ceiling";
      afterMs: number;
      requests: number;
      sockets: number;
      /** Requests still owed an answer at the ceiling. */
      owed: number;
    };

interface Owed {
  tabId: string;
  /** The tuple it asked for (`key\0pk`). */
  tuple: string;
}

export interface ReplaySettle<S extends object> {
  /** A replay request `id` of `tabId` for `tuple` arrived on `socket`. */
  owe(socket: S, tabId: string, id: number, tuple: string): void;
  /** The answer to request `id` of `tabId` left on `socket`. */
  answered(socket: S, tabId: string, id: number): void;
  /** `socket` closed: nothing it asked for is owed any more. */
  closed(socket: S): void;
  /** Something released subs on `socket` (an unsub): re-judge what is owed. */
  released(): void;
  /**
   * Start the herd window and the ceiling (idempotent — the first call
   * arms) and resolve once settled. Call at the ready barrier.
   */
  settled(): Promise<ReplaySettled>;
}

export function createReplaySettle<S extends object>(deps: {
  now: () => number;
  /** Whether `socket` still owes `tabId` an answer for `tuple`. */
  stillOwed: (socket: S, tabId: string, tuple: string) => boolean;
  bounds?: ReplaySettleBounds;
}): ReplaySettle<S> {
  const bounds = deps.bounds ?? REPLAY_SETTLE_BOUNDS;
  const owed = new Map<S, Map<string, Owed>>();
  // The sockets that replayed, counted once each (weak: never kept alive).
  const replayedOn = new WeakSet<S>();
  let sockets = 0;
  let requests = 0;
  let owedCount = 0;
  let lastActivity = 0;
  let armedAt: number | null = null;
  let outcome: ReplaySettled | null = null;
  const done = promiseWithResolvers<ReplaySettled>();
  let judgeTimer: ReturnType<typeof setTimeout> | null = null;
  let herdTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

  const idOf = (tabId: string, id: number): string => `${tabId}\0${id}`;

  function timer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    // Never keeps a process alive on its own.
    (t as { unref?: () => void }).unref?.();
    return t;
  }

  function settle(o: ReplaySettled): void {
    if (outcome !== null) return;
    outcome = o;
    for (const t of [judgeTimer, herdTimer, ceilingTimer])
      if (t !== null) clearTimeout(t);
    owed.clear();
    done.resolve(o);
  }

  function prune(): void {
    for (const [socket, bySocket] of owed) {
      for (const [k, o] of bySocket) {
        if (!deps.stillOwed(socket, o.tabId, o.tuple)) {
          bySocket.delete(k);
          owedCount -= 1;
        }
      }
      if (bySocket.size === 0) owed.delete(socket);
    }
  }

  // Judge at the end of the quiet window, once armed and the herd has begun.
  function scheduleJudge(): void {
    if (outcome !== null || armedAt === null || requests === 0) return;
    if (judgeTimer !== null) clearTimeout(judgeTimer);
    const due = Math.max(0, lastActivity + bounds.quietMs - deps.now());
    judgeTimer = timer(due, judge);
  }

  function judge(): void {
    judgeTimer = null;
    if (outcome !== null || armedAt === null) return;
    prune();
    if (owedCount > 0) return; // an answer, a close or a release re-judges
    const quietFor = deps.now() - lastActivity;
    if (quietFor < bounds.quietMs) return scheduleJudge();
    settle({
      kind: "replayed",
      afterMs: deps.now() - armedAt,
      requests,
      sockets,
    });
  }

  // Once, at the first of arming and the first replay request.
  function startCeiling(): void {
    if (ceilingTimer !== null || outcome !== null) return;
    const from = deps.now();
    ceilingTimer = timer(bounds.ceilingMs, () => {
      prune();
      settle({
        kind: "ceiling",
        afterMs: deps.now() - (armedAt ?? from),
        requests,
        sockets,
        owed: owedCount,
      });
    });
  }

  function activity(): void {
    lastActivity = deps.now();
    scheduleJudge();
  }

  return {
    owe(socket, tabId, id, tuple) {
      if (outcome !== null) return;
      let bySocket = owed.get(socket);
      if (bySocket === undefined) owed.set(socket, (bySocket = new Map()));
      const k = idOf(tabId, id);
      if (!bySocket.has(k)) owedCount += 1;
      bySocket.set(k, { tabId, tuple });
      if (!replayedOn.has(socket)) {
        replayedOn.add(socket);
        sockets += 1;
      }
      requests += 1;
      startCeiling();
      if (herdTimer !== null) {
        clearTimeout(herdTimer);
        herdTimer = null;
      }
      activity();
    },
    answered(socket, tabId, id) {
      if (outcome !== null) return;
      const bySocket = owed.get(socket);
      if (bySocket === undefined || !bySocket.delete(idOf(tabId, id))) {
        // Not a request owed here — but a request owed for its tuple may be
        // answered by it under another id (or dropped by another path):
        // re-judge, so a stale entry never holds the wait to the ceiling.
        if (owedCount > 0) scheduleJudge();
        return;
      }
      owedCount -= 1;
      if (bySocket.size === 0) owed.delete(socket);
      activity();
    },
    closed(socket) {
      if (outcome !== null) return;
      const bySocket = owed.get(socket);
      if (bySocket === undefined) return;
      owedCount -= bySocket.size;
      owed.delete(socket);
      activity();
    },
    released() {
      if (outcome !== null || owedCount === 0) return;
      scheduleJudge();
    },
    settled() {
      if (armedAt === null && outcome === null) {
        armedAt = deps.now();
        const armed = armedAt;
        startCeiling();
        if (requests === 0) {
          herdTimer = timer(bounds.herdWaitMs, () => {
            herdTimer = null;
            if (requests === 0) {
              settle({ kind: "no-replay", afterMs: deps.now() - armed });
            }
          });
        } else {
          scheduleJudge();
        }
      }
      return done.promise;
    },
  };
}
