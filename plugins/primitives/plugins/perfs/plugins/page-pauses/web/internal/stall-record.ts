import { pushBounded, type Interval } from "./intervals";

/**
 * How long a long frame's entry may take to reach its observer after the
 * frame — the longest a consumer waits before judging a span without it.
 * Agrees with main-thread-stall's `STALL.FRAME_GRACE_MS` (the same wait, for
 * the same entry, before it files a recovered freeze).
 *
 * Why a consumer must wait at all: the browser delivers the entry in a task of
 * its own, after the frame, and on a page still busy from the stall that task
 * runs late. On main (2026-11-15 09:58 UTC) a 1102 ms frame opening a long page
 * had not reached the record ≥ 380 ms after it ended, when the slow-op queue
 * judged the four updates and two element settles that had sat behind it — so
 * each was filed with the stall as its own time (1.07–1.98 s), six reports for
 * one stall that main-thread-stall had filed already.
 */
export const STALL_ENTRY_GRACE_MS = 2000;

interface Waiter {
  throughMs: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface StallRecordOptions {
  /** A frame at least this long is a stall. */
  minMs: number;
  /** Stall intervals kept (the oldest dropped). */
  cap: number;
  graceMs?: number;
  now?: () => number;
}

/**
 * The page's long frames on the wall clock, and WHEN that record is complete.
 *
 * Long frames reach the record in order (one observer, entries in creation
 * order), so once an entry starting at or after `t` has arrived, every frame
 * that ended by `t` is in it: `knownThrough(t)` resolves then — on a busy page
 * (the case that matters) within a frame or two — or `graceMs` after `t` at the
 * latest (a calm page has no later long frame to prove it; one timer, never a
 * poll).
 */
export function createStallRecord(opts: StallRecordOptions) {
  const graceMs = opts.graceMs ?? STALL_ENTRY_GRACE_MS;
  const now = opts.now ?? Date.now;
  const stalls: Interval[] = [];
  /** Start of the latest frame entry seen (any length), wall ms. */
  let latestStartMs = -Infinity;
  let waiters: Waiter[] = [];

  function settle(w: Waiter): void {
    clearTimeout(w.timer);
    w.resolve();
  }

  return {
    stalls: stalls as readonly Interval[],

    /** One frame entry, any length, placed on the wall clock. */
    noteFrame(startMs: number, durationMs: number): void {
      if (durationMs >= opts.minMs)
        pushBounded(stalls, { startMs, endMs: startMs + durationMs }, opts.cap);
      if (startMs <= latestStartMs) return;
      latestStartMs = startMs;
      const done = waiters.filter((w) => w.throughMs <= latestStartMs);
      if (done.length === 0) return;
      waiters = waiters.filter((w) => w.throughMs > latestStartMs);
      for (const w of done) settle(w);
    },

    /** Resolves once every frame that ended by `throughMs` is in the record. */
    knownThrough(throughMs: number): Promise<void> {
      if (throughMs <= latestStartMs) return Promise.resolve();
      const waitMs = throughMs + graceMs - now();
      if (waitMs <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const w: Waiter = {
          throughMs,
          resolve,
          timer: setTimeout(() => {
            waiters = waiters.filter((x) => x !== w);
            resolve();
          }, waitMs),
        };
        waiters.push(w);
      });
    },
  };
}

export type StallRecord = ReturnType<typeof createStallRecord>;
