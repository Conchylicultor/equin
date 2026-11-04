// What the reconnect linger actually did, for `_debug.linger`.
//
// The linger (`SOCKET_LINGER_MS`, the runtime's `detached`) holds a closed
// socket's subs until its tabs replay them on a new socket. Whether that wins
// on a real wake from sleep depends on what no test can see: when the server
// saw the close, whether its timers ran on through the sleep, and how long
// after the wake the tab came back. This ledger records it per closed socket:
// how the linger ended (every tab replayed or left, or the bound passed), how
// long it held in wall time, on the monotonic clock the timer runs on, and
// asleep (the host's sleep clock, when it has one), and — the cost the linger
// exists to avoid — a tab whose linger had already expired coming back
// (`lateReplay`): its whole set reloads.
//
// Bounded: the last `EPISODE_CAP` episodes, and the expired tabs still awaited
// for at most `EXPIRED_TAB_CAP` entries (the oldest dropped first).
// research/2026-11-04-global-live-reconnect-linger-and-version-clock.md

const EPISODE_CAP = 50;
const EXPIRED_TAB_CAP = 200;

/** How a closed socket's linger ended. */
export type LingerEnd =
  /** Its last tab's complete replay registered on another socket. */
  | "replayed"
  /** Its last tab's `unsub-tab` arrived. */
  | "unsub-tab"
  /** `SOCKET_LINGER_MS` passed with records still held: they were released. */
  | "expired";

/** Elapsed since the socket closed, on each clock. */
export interface LingerSpan {
  /** `Date.now()` delta: runs through a sleep. */
  wallMs: number;
  /** `performance.now()` delta: the clock the runtime's timers are judged by. */
  monoMs: number;
  /** Time the machine slept in the span; null where the host cannot tell. */
  asleepMs: number | null;
}

export interface LingerEpisode {
  /** Epoch ms the socket closed. */
  closedAt: number;
  /** Tabs holding subs on it, and its (key, pk) records, at the close. */
  tabs: number;
  records: number;
  /** null while it still lingers. */
  endedBy: LingerEnd | null;
  /** From the close to the end; null while it still lingers. */
  held: LingerSpan | null;
  /** Records released by the bound rather than by their tab (0 unless expired). */
  expiredRecords: number;
  /** A tab of an expired linger replayed after the bound: from the close to that replay. */
  lateReplay: LingerSpan | null;
}

export interface LingerLedgerSnapshot {
  ended: Record<LingerEnd, number>;
  lateReplays: number;
  /** Oldest first. */
  episodes: LingerEpisode[];
}

export interface LingerLedger {
  opened(socket: object, tabs: number, records: number): void;
  /** `left`: what the bound released — the records and tabs still held (none unless expired). */
  ended(
    socket: object,
    by: LingerEnd,
    left?: { records: number; tabs: ReadonlySet<string> },
  ): void;
  /** A tab's complete replay arrived. */
  returned(tabId: string): void;
  snapshot(): LingerLedgerSnapshot;
}

interface Stamp {
  wall: number;
  mono: number;
  asleep: number | null;
}

export function createLingerLedger(
  asleepMs: () => number | null,
): LingerLedger {
  const stamp = (): Stamp => ({
    wall: Date.now(),
    mono: performance.now(),
    asleep: asleepMs(),
  });
  const since = (from: Stamp): LingerSpan => {
    const now = stamp();
    return {
      wallMs: now.wall - from.wall,
      monoMs: Math.round(now.mono - from.mono),
      // Two raw clock reads differ by sub-ms jitter: whole ms, never negative.
      asleepMs:
        from.asleep === null || now.asleep === null
          ? null
          : Math.max(0, Math.round(now.asleep - from.asleep)),
    };
  };

  const open = new Map<object, { episode: LingerEpisode; at: Stamp }>();
  // A tab of an expired linger, until it comes back (or is pushed out).
  const expiredTabs = new Map<string, { episode: LingerEpisode; at: Stamp }>();
  const episodes: LingerEpisode[] = [];
  const ended: Record<LingerEnd, number> = {
    replayed: 0,
    "unsub-tab": 0,
    expired: 0,
  };
  let lateReplays = 0;

  return {
    opened(socket, tabs, records) {
      const episode: LingerEpisode = {
        closedAt: Date.now(),
        tabs,
        records,
        endedBy: null,
        held: null,
        expiredRecords: 0,
        lateReplay: null,
      };
      episodes.push(episode);
      if (episodes.length > EPISODE_CAP) episodes.shift();
      open.set(socket, { episode, at: stamp() });
    },
    ended(socket, by, left) {
      const o = open.get(socket);
      if (o === undefined) return;
      open.delete(socket);
      o.episode.endedBy = by;
      o.episode.held = since(o.at);
      o.episode.expiredRecords = left?.records ?? 0;
      ended[by]++;
      // A tab that left a record behind is awaited: its replay is a late one.
      for (const tab of left?.tabs ?? []) {
        expiredTabs.delete(tab);
        expiredTabs.set(tab, { episode: o.episode, at: o.at });
        if (expiredTabs.size > EXPIRED_TAB_CAP) {
          expiredTabs.delete(expiredTabs.keys().next().value!);
        }
      }
    },
    returned(tabId) {
      const e = expiredTabs.get(tabId);
      if (e === undefined) return;
      expiredTabs.delete(tabId);
      lateReplays++;
      e.episode.lateReplay ??= since(e.at);
    },
    snapshot() {
      return {
        ended: { ...ended },
        lateReplays,
        episodes: episodes.map((e) => ({ ...e })),
      };
    },
  };
}
