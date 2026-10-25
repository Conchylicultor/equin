/**
 * Watches of a key whose target is not known yet — a conversation subscribed
 * before its row (or its attempt's) is written — parked until a load resolves
 * it. Modelled on code-explorer's `rootWaiters`
 * (code-explorer/machine/internal/workspace.ts), with the park taken BEFORE
 * the subscribe's own resolve: a load that resolves the target while that
 * resolve is in flight (the row's insert re-ran it) opens the watch, rather
 * than finding nobody parked yet and leaving the watch never opened — the
 * value stale for as long as it is subscribed.
 */
export interface ParkedWatches<T> {
  /**
   * A load found `key`'s target: open every watch parked on it. Every load
   * that resolves the target calls it, so the load a row's insert re-ran is
   * the one that opens the watch.
   */
  resolved(key: string, target: T): void;
  /**
   * Hold `open(target)` on `key`'s target until the returned stop runs.
   * `resolveNow` is the subscribe's own resolve: a target found there opens
   * at once (resolves once open, rejects with the open's failure). None yet
   * parks the watch: the first `resolved(key, …)` opens it, and `onChange`
   * runs once it is open, so a change between that load and the watch going
   * live is not lost.
   */
  watch(
    key: string,
    resolveNow: () => Promise<T | null>,
    open: (target: T) => Promise<() => void>,
    onChange: () => void,
  ): Promise<() => void>;
}

export interface ParkedWatchesOptions {
  /**
   * A PARKED watch's open failed — opened from a load, so no subscribe is
   * there to reject. Report it: the watch is parked again, so the next load
   * that resolves the target retries it, but until then the value has no
   * change signal.
   */
  onOpenError: (key: string, err: unknown) => void;
}

export function createParkedWatches<T>(
  options: ParkedWatchesOptions,
): ParkedWatches<T> {
  const parked = new Map<string, Set<(target: T) => void>>();

  const park = (key: string, arm: (target: T) => void): void => {
    let waiting = parked.get(key);
    if (waiting === undefined) parked.set(key, (waiting = new Set()));
    waiting.add(arm);
  };
  const unpark = (key: string, arm: (target: T) => void): void => {
    const set = parked.get(key);
    set?.delete(arm);
    if (set?.size === 0) parked.delete(key);
  };

  return {
    resolved: (key, target) => {
      const waiting = parked.get(key);
      if (waiting === undefined) return;
      parked.delete(key);
      for (const arm of waiting) arm(target);
    },
    watch: async (key, resolveNow, open, onChange) => {
      let stopped = false;
      // Whether a target was taken — by a load (`arm`) or by `resolveNow` —
      // so a watch opens once, whichever finds it first.
      let taken = false;
      let stop: () => void = () => {};
      const arm = (target: T): void => {
        if (taken) return;
        taken = true;
        void open(target).then(
          (opened) => {
            if (stopped) {
              opened();
              return;
            }
            stop = opened;
            onChange();
          },
          (err: unknown) => {
            // Nothing is open: park again for the next resolving load, and
            // say so — never a notify, whose loader re-run would retry at
            // once, in a loop while the open keeps failing.
            taken = false;
            if (!stopped) park(key, arm);
            options.onOpenError(key, err);
          },
        );
      };
      park(key, arm);
      const release = (): void => {
        stopped = true;
        unpark(key, arm);
        stop();
      };
      let now: T | null;
      try {
        now = await resolveNow();
      } catch (err) {
        // The subscribe failed: nothing may stay parked under it.
        release();
        throw err;
      }
      if (now !== null && !taken) {
        taken = true;
        unpark(key, arm);
        try {
          stop = await open(now);
        } catch (err) {
          release();
          throw err;
        }
      }
      return release;
    },
  };
}
