/** Totals since the coalescer was created, across every key. */
export interface CoalescerStats {
  /** `trigger` / `run` calls. */
  triggers: number;
  /** Reactions actually run. */
  runs: number;
  /** Triggers folded into a run already pending (they cost no run of their own). */
  folded: number;
}

export interface KeyedCoalescer<K, E> {
  /**
   * Ask for a run of `key` with `items`. Idle: the run starts now (its
   * synchronous part before this returns). Running: the items join the ONE
   * pending run, which starts when the current one settles. A failing run is
   * loud (an unhandled rejection) unless a `run()` caller is waiting on it.
   */
  trigger(key: K, items?: readonly E[]): void;
  /**
   * {@link trigger}, resolving once the run that covers this call — one that
   * started AFTER it — has settled; rejecting with that run's error.
   */
  run(key: K, items?: readonly E[]): Promise<void>;
  /** Resolves once `key` has nothing running or pending. */
  idle(key: K): Promise<void>;
  stats(): CoalescerStats;
}

export interface Coalescer<E> {
  /** See {@link KeyedCoalescer.trigger}. */
  trigger(items?: readonly E[]): void;
  /** See {@link KeyedCoalescer.run}. */
  run(items?: readonly E[]): Promise<void>;
  /** Resolves once nothing is running or pending. */
  idle(): Promise<void>;
  stats(): CoalescerStats;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** One run to come: the items it will be handed and who awaits it. */
interface Generation<E> {
  items: E[];
  waiters: Waiter[];
}

interface Slot<E> {
  running: boolean;
  pending: Generation<E> | null;
  idleWaiters: (() => void)[];
}

/**
 * Run `reaction(key, items)` at most once at a time per key. Every trigger
 * that lands while a run is in flight folds into ONE pending run (its items
 * appended), started when the current one settles — so a burst of N triggers
 * against slow work costs at most two runs per key, never N, and a trigger
 * that lands mid-run is never answered by a run that began before it.
 *
 * A failed run never wedges the key: the pending run still starts.
 *
 * ```ts
 * const recompute = createKeyedCoalescer<string, never>({
 *   run: (worktree) => recomputeEditedFiles(worktree),
 * });
 * recompute.trigger(worktree); // from a watcher callback, as often as it likes
 * ```
 */
export function createKeyedCoalescer<K, E = never>(opts: {
  run: (key: K, items: E[]) => Promise<unknown> | void;
}): KeyedCoalescer<K, E> {
  const slots = new Map<K, Slot<E>>();
  const stats: CoalescerStats = { triggers: 0, runs: 0, folded: 0 };

  function enqueue(key: K, items: readonly E[] | undefined): Generation<E> {
    stats.triggers += 1;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { running: false, pending: null, idleWaiters: [] };
      slots.set(key, slot);
    }
    let gen = slot.pending;
    if (gen === null) {
      gen = { items: [], waiters: [] };
      slot.pending = gen;
    } else {
      stats.folded += 1;
    }
    if (items !== undefined) gen.items.push(...items);
    return gen;
  }

  function start(key: K): void {
    const slot = slots.get(key);
    if (slot === undefined || slot.running) return;
    const gen = slot.pending;
    if (gen === null) {
      slots.delete(key);
      for (const resolve of slot.idleWaiters) resolve();
      return;
    }
    slot.pending = null;
    slot.running = true;
    stats.runs += 1;
    // `unknown`: a `void`-typed callback may return anything (`arr.push`'s
    // count), so only a thenable is async work.
    let result: unknown;
    try {
      result = opts.run(key, gen.items);
    } catch (err) {
      settle(key, slot, gen, { failed: true, error: err });
      return;
    }
    // A sync run settles inline, so a sync reaction (`notify()`) leaves the key
    // free for the next trigger in the same turn.
    if (!isThenable(result)) {
      settle(key, slot, gen, { failed: false });
      return;
    }
    void result.then(
      () => settle(key, slot, gen, { failed: false }),
      (err: unknown) => settle(key, slot, gen, { failed: true, error: err }),
    );
  }

  function settle(
    key: K,
    slot: Slot<E>,
    gen: Generation<E>,
    outcome: { failed: false } | { failed: true; error: unknown },
  ): void {
    slot.running = false;
    start(key);
    if (!outcome.failed) {
      for (const w of gen.waiters) w.resolve();
      return;
    }
    for (const w of gen.waiters) w.reject(outcome.error);
    // Nobody awaits this run: surface the failure as the unhandled rejection
    // a detached reaction would have raised — never into the trigger's caller.
    if (gen.waiters.length === 0) void Promise.reject(outcome.error);
  }

  return {
    trigger(key, items) {
      enqueue(key, items);
      start(key);
    },
    run(key, items) {
      const gen = enqueue(key, items);
      const done = new Promise<void>((resolve, reject) => {
        gen.waiters.push({ resolve, reject });
      });
      start(key);
      return done;
    },
    idle(key) {
      const slot = slots.get(key);
      if (slot === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => slot.idleWaiters.push(resolve));
    },
    stats: () => ({ ...stats }),
  };
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/** {@link createKeyedCoalescer} with a single key. */
export function createCoalescer<E = never>(opts: {
  run: (items: E[]) => Promise<unknown> | void;
}): Coalescer<E> {
  const keyed = createKeyedCoalescer<null, E>({
    run: (_key, items) => opts.run(items),
  });
  return {
    trigger: (items) => keyed.trigger(null, items),
    run: (items) => keyed.run(null, items),
    idle: () => keyed.idle(null),
    stats: () => keyed.stats(),
  };
}
