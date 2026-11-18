import {
  beginWait,
  captureContext,
  type ContextRunner,
} from "@plugins/infra/plugins/runtime-profiler/core";

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
  /**
   * Resolves once every run of `key` running or pending at the call has
   * settled (fulfilled or failed — a failure stays loud where it always was).
   * Unlike {@link idle}, a trigger landing after the call is not waited for,
   * so it resolves under a steady stream of triggers too.
   */
  settled(key: K): Promise<void>;
  stats(): CoalescerStats;
}

export interface Coalescer<E> {
  /** See {@link KeyedCoalescer.trigger}. */
  trigger(items?: readonly E[]): void;
  /** See {@link KeyedCoalescer.run}. */
  run(items?: readonly E[]): Promise<void>;
  /** Resolves once nothing is running or pending. */
  idle(): Promise<void>;
  /** See {@link KeyedCoalescer.settled}. */
  settled(): Promise<void>;
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
  /** `settled()` callers: resolved when this run settles, whatever its outcome. */
  settledWaiters: (() => void)[];
  /**
   * The context the run starts in: that of the trigger that asked for it
   * first. A run asked for while the key is idle starts inline, in its
   * caller's context already; one folded behind a run in flight is started by
   * that run's settle, whose context belongs to whoever started THAT run — a
   * boot hook's first pass would own the trailing pass a file change asked
   * for (git-watcher, 2026-11-18: `git-watcher:recompute` reported as work
   * its onReady left running).
   */
  inContext: ContextRunner;
}

interface Slot<E> {
  running: boolean;
  /** The run in flight (`null` while none is). */
  current: Generation<E> | null;
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
  /**
   * What the reaction is, as the profiler names a wait on it: a caller
   * awaiting a run it did not start (`run` served by a run another caller's
   * settle starts, `idle`, `settled`) waits on another party's work, shown and
   * charged as the `coalesce:<name>` join — never as its own time.
   */
  name: string;
  run: (key: K, items: E[]) => Promise<unknown> | void;
}): KeyedCoalescer<K, E> {
  const slots = new Map<K, Slot<E>>();
  const joinLayer = `coalesce:${opts.name}`;

  /**
   * `done`, awaited as a join on another party's run: announced now, in the
   * waiter's own context, and charged as it settles.
   */
  function joined<T>(done: Promise<T>): Promise<T> {
    const end = beginWait(joinLayer, "join");
    return done.finally(end);
  }
  const stats: CoalescerStats = { triggers: 0, runs: 0, folded: 0 };

  function enqueue(key: K, items: readonly E[] | undefined): Generation<E> {
    stats.triggers += 1;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { running: false, current: null, pending: null, idleWaiters: [] };
      slots.set(key, slot);
    }
    let gen = slot.pending;
    if (gen === null) {
      gen = {
        items: [],
        waiters: [],
        settledWaiters: [],
        inContext: slot.running ? captureContext() : runInline,
      };
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
    slot.current = gen;
    stats.runs += 1;
    // `unknown`: a `void`-typed callback may return anything (`arr.push`'s
    // count), so only a thenable is async work.
    let result: unknown;
    try {
      const items = gen.items;
      result = gen.inContext(() => opts.run(key, items));
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
    slot.current = null;
    start(key);
    for (const resolve of gen.settledWaiters) resolve();
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
      // Idle, this very call starts the run: it is this caller's work (it
      // runs in this context, its spans nest here) — a starter waits for
      // nothing, as `inflight`'s. Otherwise it is folded behind a run already
      // in flight, and runs when THAT settles (in the context of the trigger
      // that asked for it first): a join.
      const startsHere = slots.get(key)?.running === false;
      start(key);
      return startsHere ? done : joined(done);
    },
    idle(key) {
      const slot = slots.get(key);
      if (slot === undefined) return Promise.resolve();
      return joined(
        new Promise<void>((resolve) => slot.idleWaiters.push(resolve)),
      );
    },
    settled(key) {
      // The pending run starts after the running one settles, so it is the
      // last of the two to settle.
      const slot = slots.get(key);
      const last = slot?.pending ?? slot?.current ?? null;
      if (last === null) return Promise.resolve();
      return joined(
        new Promise<void>((resolve) => last.settledWaiters.push(resolve)),
      );
    },
    stats: () => ({ ...stats }),
  };
}

const runInline: ContextRunner = (fn) => fn();

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/** {@link createKeyedCoalescer} with a single key. */
export function createCoalescer<E = never>(opts: {
  /** See {@link createKeyedCoalescer}'s `name`. */
  name: string;
  run: (items: E[]) => Promise<unknown> | void;
}): Coalescer<E> {
  const keyed = createKeyedCoalescer<null, E>({
    name: opts.name,
    run: (_key, items) => opts.run(items),
  });
  return {
    trigger: (items) => keyed.trigger(null, items),
    run: (items) => keyed.run(null, items),
    idle: () => keyed.idle(null),
    settled: () => keyed.settled(null),
    stats: () => keyed.stats(),
  };
}
