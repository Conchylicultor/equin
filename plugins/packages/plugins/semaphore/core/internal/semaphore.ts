import {
  runHoldingSlot,
  runInLeaseScope,
  type YieldableLease,
} from "./lease-scope";

/**
 * How much of the gate one caller takes, and how it observes the wait. ONE
 * options object rather than a positional `onWait` plus a weight: a second
 * spelling of the same call would have to be kept in step forever, and
 * `packages/inflight`'s `run(key, fn, { onWait, … })` already reads this way.
 */
export interface SlotOptions {
  /**
   * How many of the gate's `max` units this caller occupies (default 1, a
   * positive integer). It is acquired ATOMICALLY — all of it or none — so two
   * heavy callers can never each hold half of what they need and deadlock.
   *
   * `weight > max` throws, synchronously, at the call site: a request that can
   * never fit would otherwise queue forever, and the clamp belongs to the layer
   * that knows the ceiling (see `host-admission`'s grant, which clamps a spend
   * to the units it holds) rather than to this primitive, which would have to
   * guess whether the caller meant "as much as fits" or "exactly this much".
   */
  weight?: number;
  /**
   * Called once with the milliseconds spent waiting for capacity (≈0 when it
   * was immediately free) at the moment of acquisition, before the body runs.
   * It lets callers make the gate observable — e.g. record a span for
   * queue-wait — without coupling this primitive to a profiler. Kept separate
   * from the body's own timing so queue-wait is never conflated with work time.
   */
  onWait?: (waitMs: number) => void;
  /**
   * `run` only: the slot is given back while the body merely WAITS on work
   * another caller is doing (`whileWaiting` — an `inflight` join is one), and
   * taken back ahead of every queued newcomer when the wait ends, so a gate full
   * of waiters can never stall unrelated callers (see `lease-scope.ts`). Each
   * take-back reports its own queue time through `onWait`. Off by default: a
   * slot that stands for a held resource (a DB connection, a file handle) must
   * stay held while its holder waits.
   */
  yieldable?: boolean;
}

export interface Semaphore {
  /**
   * Run `fn` once there is room, releasing its weight when it settles. Capacity
   * is handed to waiters in FIFO order. The release happens in a `finally`, so
   * a rejecting `fn` never leaks capacity — `run` rejects with the same error.
   */
  run<T>(fn: () => Promise<T>, opts?: SlotOptions): Promise<T>;

  /**
   * Acquire capacity, returning an idempotent release function. For leases whose
   * lifetime is not a function call — e.g. a pooled DB connection held from
   * checkout to `release()`. `run` is this plus a `finally`.
   */
  acquire(opts?: SlotOptions): Promise<() => void>;

  /**
   * Observability-only snapshot of current occupancy: how much WEIGHT is held
   * right now (not how many callers — an unweighted gate is the same number),
   * how many callers are queued, and the configured cap. Lets a gate owner
   * expose a gauge — e.g. sample occupancy into a flight recorder — without
   * coupling this primitive to a profiler. Reads existing counters; zero
   * hot-path cost.
   */
  stats(): { active: number; queued: number; max: number };
}

/**
 * Bounded-concurrency gate: the held weight of the running bodies never exceeds
 * `max`; the rest queue FIFO. A counter + waiter queue, nothing more — pair it
 * with a profiler span or DB pool to cap how many callers hit a shared resource
 * simultaneously.
 *
 * Every caller weighs 1 unless it says otherwise, so a gate whose callers all
 * cost the same is a plain count. A caller that is measurably heavier than the
 * others declares a `weight` and occupies that many units, which is what keeps
 * the cap a statement about the RESOURCE rather than about how many callers
 * happen to be in flight.
 */
export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `createSemaphore: max must be a positive integer, got ${max}`,
    );
  }
  /** Held weight, not held count — equal only while every caller weighs 1. */
  let active = 0;
  const waiters: Array<{ weight: number; admit: () => void }> = [];

  function weightOf(opts: SlotOptions | undefined): number {
    const weight = opts?.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1) {
      throw new Error(
        `semaphore: weight must be a positive integer, got ${weight}`,
      );
    }
    if (weight > max) {
      throw new Error(
        `semaphore: weight ${weight} exceeds max ${max} — this request could never be admitted. ` +
          `Clamp it where the ceiling is known.`,
      );
    }
    return weight;
  }

  function acquireSlot(weight: number, front = false): Promise<void> {
    // `waiters.length === 0` is the strict-FIFO rule, and it is what stops a
    // heavy waiter from being starved: once anyone is queued, a later arrival
    // queues behind it even if its own weight would fit in the free capacity.
    // For an unweighted gate the clause is inert — a non-empty queue implies
    // `active === max`, so the capacity test already fails.
    if (waiters.length === 0 && active + weight <= max) {
      active += weight;
      return Promise.resolve();
    }
    // `front`: a yielded slot coming back. Its body was admitted before every
    // caller now queued, so it resumes ahead of them — yielding while waiting
    // never costs the waiter its place.
    return new Promise<void>((resolve) => {
      if (front) waiters.unshift({ weight, admit: resolve });
      else waiters.push({ weight, admit: resolve });
    });
  }

  function releaseSlot(weight: number): void {
    active -= weight;
    // Hand the freed capacity straight to the head waiter — and only while the
    // head fits, never skipping it for a lighter one behind. `active` is raised
    // before `admit()` in the same synchronous turn, so no second caller can
    // race into capacity that has already been given away.
    while (waiters.length > 0 && active + waiters[0]!.weight <= max) {
      const next = waiters.shift()!;
      active += next.weight;
      next.admit();
    }
  }

  async function lease(
    weight: number,
    onWait?: (waitMs: number) => void,
  ): Promise<() => void> {
    const t0 = onWait ? performance.now() : 0;
    await acquireSlot(weight);
    onWait?.(performance.now() - t0);
    // A lease outlives the call that took it, so its owner may release twice —
    // `pg`'s `client.release` is call-once and the DB wrapper patches it. A
    // second release would free capacity this lease never held, pushing
    // occupancy past `max` and silently voiding the gate's whole invariant.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot(weight);
    };
  }

  // A held slot the body may give back while it waits (`SlotOptions.yieldable`).
  // `waits` counts the body's overlapping waits: the first gives the slot back,
  // the last takes it back. `end` is the body settling — the slot is freed if
  // held, and a take-back still queued frees it again the moment it lands.
  function yieldableLease(
    weight: number,
    onWait: ((waitMs: number) => void) | undefined,
  ): YieldableLease & { end(): void } {
    let held = true;
    let ended = false;
    let waits = 0;
    let reclaiming: Promise<void> | undefined;
    const giveBack = () => {
      held = false;
      releaseSlot(weight);
    };
    return {
      get ended() {
        return ended;
      },
      beginWait() {
        waits++;
        if (waits === 1 && held) giveBack();
      },
      endWait() {
        waits--;
        if (waits > 0 || ended || held) return Promise.resolve();
        reclaiming ??= (async () => {
          const t0 = performance.now();
          await acquireSlot(weight, true);
          onWait?.(performance.now() - t0);
          reclaiming = undefined;
          held = true;
          // Settled, or waiting again, while the take-back queued.
          if (ended || waits > 0) giveBack();
        })();
        return reclaiming;
      },
      end() {
        ended = true;
        if (held) giveBack();
      },
    };
  }

  // Deliberately NOT `async`: a bad weight is a wiring bug, and it must reach
  // the call site as a throw rather than as a rejected promise nobody may be
  // awaiting yet.
  function acquire(opts?: SlotOptions): Promise<() => void> {
    return lease(weightOf(opts), opts?.onWait);
  }

  return {
    acquire,
    run<T>(fn: () => Promise<T>, opts?: SlotOptions): Promise<T> {
      const weight = weightOf(opts); // throws here, not in the promise
      const pending = lease(weight, opts?.onWait);
      if (opts?.yieldable) {
        return (async () => {
          await pending; // its release is `held.end()`'s: one owner of the slot
          const held = yieldableLease(weight, opts.onWait);
          try {
            return await runInLeaseScope(held, fn);
          } finally {
            held.end();
          }
        })();
      }
      return (async () => {
        const release = await pending;
        try {
          return await runHoldingSlot(fn);
        } finally {
          release();
        }
      })();
    },
    stats: () => ({ active, queued: waiters.length, max }),
  };
}
