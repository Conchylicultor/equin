import { whileWaiting } from "@plugins/packages/plugins/semaphore/core";

/** Per-call options for `Inflight.run`. */
export interface InflightOptions {
  /**
   * Called once, synchronously and in the JOINER's own async context, the
   * moment a caller joins an EXISTING in-flight promise; the function it
   * returns is called when that shared flight settles (`finally`-based, so a
   * rejecting flight still ends it). Only JOINERS call it: neither the starter
   * (whose time is `fn`'s own execution, not a wait) nor a caller that
   * SUPERSEDED a too-old flight (also a starter — it waits for nothing).
   *
   * One callback for both moments, so a caller cannot report a join's wait
   * without having shown it while it lasted — runtime-profiler's
   * `beginWait(layer, "join")` is exactly this shape (it shows the wait on the
   * joiner's open spans, and its end charges the time). This primitive stays
   * profiler-free.
   */
  onJoin?: () => () => void;
  /**
   * Freshness floor on the `performance.now()` clock: refuse to join a flight
   * that STARTED before this instant. The caller is saying "I already know about
   * something that happened at `notBefore`; a body that began before it cannot
   * reflect it." Omitted (the default) ⇒ join any live flight, byte-identical to
   * a plain deduplicator.
   *
   * The floor is compared against the moment `fn` was INVOKED, not the moment it
   * did its first real read — so a flight that queues behind an admission gate
   * records a `startedAt` earlier than its first read. That is deliberately
   * conservative: it yields false refusals (one extra run of `fn`) and never a
   * false join.
   */
  notBefore?: number;
  /**
   * Called once, on the superseding caller, when an existing flight was too old
   * for this call's `notBefore` and was therefore replaced. Observability only —
   * the supersession happens with or without it.
   */
  onSupersede?: () => void;
}

/** The running flight, as its own body sees it (`Inflight.run`'s `fn`). */
export interface InflightFlight {
  /**
   * Stop anyone else joining this flight: from now on a caller with its key
   * starts a fresh one. For a body that has decided its answer is no use to a
   * caller arriving later (it is giving up), so none inherits it. Callers that
   * already joined still share this flight's outcome. A no-op once the key
   * names another flight (a supersession).
   */
  detach(): void;
}

export interface Inflight {
  /**
   * Run `fn` under `key`, sharing one in-flight promise across concurrent
   * callers with the same key. The first caller starts `fn`; callers that arrive
   * while it is unsettled receive the *same* promise (and so the same resolved
   * value or rejection). The key is released the moment that promise settles —
   * unless it has meanwhile been taken over by a fresher flight (see the
   * freshness floor below) — so the next call after settlement runs `fn` fresh.
   *
   * This is a *concurrency* deduplicator, NOT a cache: it only collapses work
   * that overlaps in time. Pair it with a TTL cache if you also want to reuse a
   * settled result. Because the shared body runs once, never use it to dedupe
   * operations whose callers each need a distinct side effect (e.g. mutations).
   *
   * It does, however, honour a caller-supplied FRESHNESS FLOOR (`opts.notBefore`):
   * *a flight that began before something you already know about will not serve
   * you*. Overlapping in time is the right sharing rule for a caller that only
   * wants the work done once; it is the wrong one for a caller that needs the
   * read to reflect a change that landed mid-flight. Such a caller passes the
   * instant it learned of the change, and a flight older than that is
   * SUPERSEDED — `onSupersede` fires, a fresh flight starts and takes over the
   * key, and every later arrival coalesces onto the fresh one. The old flight
   * keeps serving the joiners it already has; nothing is cancelled. Superseding
   * rather than chaining is deliberate: both bodies run either way, and chaining
   * would only make the fresh one start after the stale one finishes — doubling
   * the latency the fresh caller is waiting on. Admission control belongs to the
   * gate the caller wraps around `fn`, not here.
   *
   * See `plugins/packages/plugins/inflight/CLAUDE.md` and
   * `research/2026-08-08-global-live-state-flight-freshness.md`.
   */
  run<T>(
    key: string,
    fn: (flight: InflightFlight) => Promise<T>,
    opts?: InflightOptions,
  ): Promise<T>;
  /**
   * Number of distinct keys currently in flight (introspection / tests). A key,
   * not a flight: a superseded flight is still running but no longer holds the
   * key, so it is NOT counted.
   */
  readonly size: number;
}

/**
 * In-flight request deduplicator: a `Map<key, {promise, startedAt}>`, nothing
 * more. Use it to stop a burst of identical concurrent reads (same loader fired
 * from N tabs, the same git/subprocess batch requested by two callers at once)
 * from doing the work N times — they share one execution and one result — while
 * letting a caller that needs post-change freshness refuse a flight older than
 * what it already knows (`notBefore`).
 */
export function createInflight(): Inflight {
  // `token` is the flight's identity, minted before its promise exists so the
  // settle handler has something total to compare against (see the release
  // below); `startedAt` is when its body was invoked.
  const pending = new Map<
    string,
    { promise: Promise<unknown>; startedAt: number; token: object }
  >();
  return {
    run<T>(
      key: string,
      fn: (flight: InflightFlight) => Promise<T>,
      opts?: InflightOptions,
    ): Promise<T> {
      const existing = pending.get(key);
      // Join only a flight that satisfies the caller's freshness floor. No floor
      // ⇒ `-Infinity` ⇒ every live flight qualifies (the plain deduplicator).
      if (existing && existing.startedAt >= (opts?.notBefore ?? -Infinity)) {
        // A joiner only waits on work the starter is doing, so it holds no
        // yieldable gate slot while it does (`whileWaiting`): a gate full of
        // joiners would otherwise stall every caller that depends on nothing
        // here. Without such a slot in its context it is the shared promise.
        const shared = whileWaiting(existing.promise as Promise<T>);
        const onJoin = opts?.onJoin;
        if (!onJoin) return shared;
        // Joiner path: announced here, synchronously, in the JOINER's own
        // async context (ambient AsyncLocalStorage attribution lands on the
        // joiner, not the starter), and ended as the shared flight settles —
        // `finally`-based so a rejecting flight still ends it.
        const end = onJoin();
        return (async () => {
          try {
            return await shared;
          } finally {
            end();
          }
        })();
      }
      // Either no flight, or one too old to serve this caller. Both are STARTER
      // paths — a superseding caller waits for nothing, so it never calls
      // `onJoin`; it only announces the supersession.
      if (existing) opts?.onSupersede?.();
      // Stamped BEFORE `fn` is invoked, so `startedAt` is a lower bound on when
      // the body could have read anything (see `InflightOptions.notBefore`).
      const startedAt = performance.now();
      // This flight's identity, minted before `fn` runs. The settle handler
      // compares it against whatever record holds the key at that moment,
      // rather than against the flight promise — which is still uninitialized
      // while `fn` executes, so a synchronously-throwing `fn` would settle
      // against a binding it cannot read.
      const token = {};
      // Release in `finally` so a rejection clears the key too — the next caller
      // retries fresh instead of inheriting a stale failed promise forever. The
      // release is IDENTITY-CHECKED: after a supersession two flights are live
      // under one key, and the older one settling must not evict the newer
      // entry (which would send the next arrival off on a third redundant run,
      // and, worse, let a caller join a flight that had already been refused).
      // `detached` covers a body that detaches before its first await, while
      // the key does not name this flight yet.
      let detached = false;
      const flight: InflightFlight = {
        detach: () => {
          detached = true;
          if (pending.get(key)?.token === token) pending.delete(key);
        },
      };
      const p = (async () => {
        try {
          return await fn(flight);
        } finally {
          if (pending.get(key)?.token === token) pending.delete(key);
        }
      })();
      if (!detached) pending.set(key, { promise: p, startedAt, token });
      return p;
    },
    get size() {
      return pending.size;
    },
  };
}
