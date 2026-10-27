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
   * call still WAITING when it aborts rejects at once with `signal.reason` and
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
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, tail);
      const settle = () => {
        if (tails.get(key) === tail) tails.delete(key);
        release();
      };
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          reject(signal!.reason);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        // The previous tail never rejects (it is our own `release`), so the
        // chain is ordering only: fn's own outcome goes to its caller alone.
        // Our turn is released only once the runs ahead of us settled — an
        // aborted waiter included — so the queue's order holds either way.
        void previous.then(() => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            settle();
            return;
          }
          void Promise.resolve().then(fn).then(resolve, reject).finally(settle);
        });
      });
    },
    get size() {
      return tails.size;
    },
  };
}
