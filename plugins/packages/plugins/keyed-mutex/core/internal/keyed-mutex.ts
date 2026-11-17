import { whileWaiting } from "@plugins/packages/plugins/semaphore/core";

/**
 * A per-key FIFO mutex: `run(key, fn)` starts `fn` only once every earlier
 * `run` for the same key has settled, in the order the calls arrived. Different
 * keys never wait on each other.
 *
 * Unlike `packages/coalesce` (which FOLDS triggers into one trailing run) and
 * `packages/inflight` (which SHARES one execution among concurrent callers),
 * every call here runs its own `fn` exactly once — for mutations that must not
 * interleave, such as keystrokes typed into one terminal.
 *
 * In-process only: it orders callers inside one process, never across two.
 */
export interface KeyedMutex {
  /**
   * Run `fn` once every earlier run for `key` has settled. With `signal`, a
   * call still WAITING when it aborts rejects with `signal.reason` (once it has
   * its gate slot back, inside a yieldable one) and
   * never runs `fn` — the calls queued behind it still wait for the runs ahead
   * of it, so giving up never lets two runs of one key overlap. An abort once
   * `fn` has started is `fn`'s own business.
   */
  run<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
  /** Keys with a run in flight or queued — 0 once everything settled. */
  readonly size: number;
}

/**
 * Wait for the runs ahead to settle (`"turn"`), or for `signal` to abort
 * first (`"aborted"`).
 *
 * A queued waiter only waits on work another caller is doing, so it waits
 * through `whileWaiting`: inside a yieldable gate slot (a live read) it gives
 * the slot back for the wait and takes it back at the head of the gate's
 * queue. Waiters that kept their slots could fill the gate while the key's
 * holder had yielded its own on a file wait (timed-fs awaits through
 * `whileWaiting`), and the holder's take-back would wait for a slot none of
 * them frees: on main, 2026-11-17, three `cost-at` reads queued on their
 * conversation's key held the resource's whole read share for good.
 */
async function waitForTurn(
  previous: Promise<void>,
  contended: boolean,
  signal: AbortSignal | undefined,
): Promise<"turn" | "aborted"> {
  if (signal?.aborted) return "aborted";
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    if (!signal) return;
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // The previous tail never rejects (it is our own `release`), so the chain is
  // ordering only: fn's own outcome goes to its caller alone.
  const wait = Promise.race([previous.then(() => "turn" as const), aborted]);
  try {
    // An uncontended run has nothing to wait for: it keeps its slot.
    return await (contended ? whileWaiting(wait) : wait);
  } finally {
    if (onAbort) signal!.removeEventListener("abort", onAbort);
  }
}

export function createKeyedMutex(): KeyedMutex {
  // key → the tail of its queue: a promise that settles when the LAST queued
  // run settles. A run chains onto the tail it found; the entry is deleted only
  // by the run that is still the tail when it settles, so an idle key holds
  // nothing.
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(
      key: string,
      fn: () => Promise<T>,
      opts?: { signal?: AbortSignal },
    ): Promise<T> {
      const signal = opts?.signal;
      const ahead = tails.get(key);
      const contended = ahead !== undefined;
      const previous = ahead ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, tail);
      const settle = () => {
        if (tails.get(key) === tail) tails.delete(key);
        release();
      };
      return (async () => {
        let turn: "turn" | "aborted";
        try {
          turn = await waitForTurn(previous, contended, signal);
        } catch (err) {
          // Never leave the key held by a call that will not run.
          void previous.then(settle);
          throw err;
        }
        // Aborted while waiting — or while taking its gate slot back after
        // its turn came: it never runs. The calls behind it wait for the runs
        // ahead of it, so giving up never lets two runs of one key overlap.
        if (turn === "aborted" || signal?.aborted) {
          void previous.then(settle);
          throw signal!.reason;
        }
        try {
          return await fn();
        } finally {
          settle();
        }
      })();
    },
    get size() {
      return tails.size;
    },
  };
}
