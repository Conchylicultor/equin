import {
  leaseContextInstalled,
  runInLeaseScope,
  type SlotUse,
  type UseLease,
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
   * Called synchronously, in the caller's context, the moment the caller has
   * to QUEUE (no room right now — never when it is admitted at once); the
   * function it returns is called the moment it is admitted, just before
   * `onWait`. `onWait` reports a wait only once it is over, so a caller queued
   * for minutes looks, until then, like a caller busy with its own work; this
   * lets a gate owner show the wait while it is still in progress (the runtime
   * profiler's `beginWait`). A use-scoped slot's take-back that queues is a wait
   * of its own and is announced the same way.
   */
  onQueued?: () => () => void;
  /**
   * `run` only: a USE-SCOPED slot — held only while the body runs one of
   * these uses (`usingSlot(use, start)`, called by the resource primitives:
   * a DB statement, a file call, a child process), and given back the rest of
   * the time. Waiting on anything else — another caller's flight, a mutex, a
   * worker thread, a timer — holds nothing, with no call site to remember.
   * The body's synchronous start runs holding the slot it was admitted with
   * (`admit`); a use finding the slot given back takes it back at the head of
   * the queue, FIFO among take-backs, each take-back reporting its queue time
   * through `onWait`. Without an async context runtime
   * (`installLeaseContextRuntime`) no use can find its slot, so the slot is
   * held for the whole body instead. See `lease-scope.ts`.
   */
  heldFor?: readonly SlotUse[];
  /**
   * With `heldFor`: take a slot to START the body (default true) — admission,
   * so the gate's FIFO order and classes apply to starting bodies too. `false`:
   * a lazy gate, taken only by a use, so a body that never makes one never
   * waits here (and, without an async context runtime, never holds a slot).
   */
  admit?: boolean;
  /**
   * Names this caller while it holds capacity, for `stats().holders`: a gate
   * owner passes what the caller is (a resource key and its params), so a slow
   * wait can say WHO held the gate — not only that it was full. Unlabelled
   * callers hold capacity like any other; they are only left out of `holders`.
   */
  label?: string;
  /**
   * Which class this caller belongs to, for a gate created with `perClass`:
   * at most that much weight of one class holds the gate at once. A queued
   * caller whose class is at its share is passed over — every other caller
   * keeps its FIFO place — so one class cannot take the whole gate. A yielded
   * slot frees its class's share too. Ignored by a gate without `perClass`.
   */
  class?: string;
}

/** How a gate is built, beyond its `max`. */
export interface SemaphoreOptions {
  /**
   * The most weight one class (`SlotOptions.class`) may hold at once, a
   * positive integer ≤ `max`. Unset: classes are not tracked.
   */
  perClass?: number;
}

/** A labelled caller holding capacity right now (see `SlotOptions.label`). */
export interface SlotHolder {
  label: string;
  /** How long it has held its slot, since it last took it (ms). */
  heldMs: number;
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
   *
   * `holders` lists the LABELLED callers holding weight right now (a use-scoped
   * slot given back for a wait is not held), longest-held first.
   */
  stats(): {
    active: number;
    queued: number;
    max: number;
    holders: SlotHolder[];
  };
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
export function createSemaphore(
  max: number,
  gateOpts: SemaphoreOptions = {},
): Semaphore {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `createSemaphore: max must be a positive integer, got ${max}`,
    );
  }
  const { perClass } = gateOpts;
  if (
    perClass !== undefined &&
    (!Number.isInteger(perClass) || perClass < 1 || perClass > max)
  ) {
    throw new Error(
      `createSemaphore: perClass must be a positive integer ≤ max (${max}), got ${perClass}`,
    );
  }
  /** Held weight, not held count — equal only while every caller weighs 1. */
  let active = 0;
  /** Held weight per class (`perClass` gates only); a class at 0 is absent. */
  const classActive = new Map<string, number>();
  type Waiter = {
    weight: number;
    cls: string | undefined;
    admit: () => void;
    front: boolean;
  };
  const waiters: Waiter[] = [];
  /**
   * How many waiters at the head of the queue are take-backs (`front`): a
   * use-scoped slot coming back. They queue ahead of every newcomer, FIFO among
   * themselves, so a resumed body never overtakes one that resumed earlier.
   */
  let frontWaiters = 0;
  /** Labelled callers holding weight now, each with when it took its slot. */
  const holding = new Set<{ label: string; since: number }>();

  // The class a caller is counted in: only on a `perClass` gate.
  function classOf(opts: SlotOptions | undefined): string | undefined {
    return perClass === undefined ? undefined : opts?.class;
  }

  // A class at its share: its waiter is passed over until one of its own frees.
  function classFull(weight: number, cls: string | undefined): boolean {
    return (
      cls !== undefined &&
      perClass !== undefined &&
      (classActive.get(cls) ?? 0) + weight > perClass
    );
  }

  function take(weight: number, cls: string | undefined): void {
    active += weight;
    if (cls !== undefined)
      classActive.set(cls, (classActive.get(cls) ?? 0) + weight);
  }

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
    if (
      perClass !== undefined &&
      opts?.class !== undefined &&
      weight > perClass
    ) {
      throw new Error(
        `semaphore: weight ${weight} exceeds perClass ${perClass} — this request could never be admitted.`,
      );
    }
    return weight;
  }

  function acquireSlot(
    weight: number,
    cls: string | undefined,
    onQueued: SlotOptions["onQueued"],
    front = false,
  ): Promise<void> {
    // "No eligible waiter ahead" is the strict-FIFO rule, and it is what stops
    // a heavy waiter from being starved: once anyone is queued, a later
    // arrival queues behind it even if its own weight would fit in the free
    // capacity. For an unweighted gate the clause is inert — an eligible
    // waiter implies `active === max`, so the capacity test already fails. A
    // waiter whose class is at its share is not ahead of anyone: it is passed
    // over until its class frees (`admitWaiters`).
    if (
      active + weight <= max &&
      !classFull(weight, cls) &&
      !waiters.some((w) => !classFull(w.weight, w.cls))
    ) {
      take(weight, cls);
      return Promise.resolve();
    }
    // `front`: a use-scoped slot coming back. Its body was admitted before
    // every newcomer, so it resumes ahead of them (behind earlier take-backs) —
    // giving the slot back while it waited never costs the body its place.
    // Announced before the waiter can be admitted, so its end always follows.
    const admitted = onQueued?.();
    return new Promise<void>((resolve) => {
      const admit = admitted
        ? () => {
            admitted();
            resolve();
          }
        : resolve;
      const waiter = { weight, cls, admit, front };
      if (front) waiters.splice(frontWaiters++, 0, waiter);
      else waiters.push(waiter);
    });
  }

  function releaseSlot(weight: number, cls: string | undefined): void {
    active -= weight;
    if (cls !== undefined) {
      const left = (classActive.get(cls) ?? 0) - weight;
      if (left > 0) classActive.set(cls, left);
      else classActive.delete(cls);
    }
    admitWaiters();
  }

  // Hand freed capacity to waiters in queue order — passing over a waiter
  // whose class is at its share, and stopping at the first other waiter that
  // does not fit (never skipping it for a lighter one behind). Capacity is
  // taken before `admit()` in the same synchronous turn, so no second caller
  // can race into capacity that has already been given away.
  function admitWaiters(): void {
    for (let i = 0; i < waiters.length;) {
      const next = waiters[i]!;
      if (classFull(next.weight, next.cls)) {
        i++;
        continue;
      }
      if (active + next.weight > max) return;
      waiters.splice(i, 1);
      if (next.front) frontWaiters--;
      take(next.weight, next.cls);
      next.admit();
    }
  }

  async function lease(
    weight: number,
    cls: string | undefined,
    onWait?: (waitMs: number) => void,
    label?: string,
    onQueued?: SlotOptions["onQueued"],
  ): Promise<() => void> {
    const t0 = onWait ? performance.now() : 0;
    await acquireSlot(weight, cls, onQueued);
    onWait?.(performance.now() - t0);
    // Recorded after `onWait`, so a waiter's own report never lists itself.
    const holder =
      label === undefined ? undefined : { label, since: performance.now() };
    if (holder) holding.add(holder);
    // A lease outlives the call that took it, so its owner may release twice —
    // `pg`'s `client.release` is call-once and the DB wrapper patches it. A
    // second release would free capacity this lease never held, pushing
    // occupancy past `max` and silently voiding the gate's whole invariant.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (holder) holding.delete(holder);
      releaseSlot(weight, cls);
    };
  }

  // A use-scoped slot (`SlotOptions.heldFor`): held while `uses` > 0 (and
  // through the body's synchronous start when admitted with one), given back
  // otherwise. The first use to find it given back takes it back at the head
  // of the queue; concurrent uses share that one take-back and the slot; the
  // last use to end gives it back. `end` is the body settling: a use it
  // started and left open (a checked-out connection) keeps the slot until it
  // ends; otherwise the slot is freed. No use starts after it (`usingSlot`
  // skips an ended lease).
  // `holder` is the run's labelled record: in `holding` exactly while held.
  function useScopedLease(
    weight: number,
    cls: string | undefined,
    heldFor: readonly SlotUse[],
    held: boolean,
    onWait: ((waitMs: number) => void) | undefined,
    onQueued: SlotOptions["onQueued"],
    label: string | undefined,
  ): UseLease & { started(): void; end(): void } {
    let ended = false;
    let uses = 0;
    let reclaiming: Promise<void> | undefined;
    const holder =
      label === undefined ? undefined : { label, since: performance.now() };
    if (held && holder) holding.add(holder);
    const giveBack = () => {
      held = false;
      if (holder) holding.delete(holder);
      releaseSlot(weight, cls);
    };
    const takeBack = () =>
      (reclaiming ??= (async () => {
        const t0 = performance.now();
        await acquireSlot(weight, cls, onQueued, true);
        onWait?.(performance.now() - t0);
        reclaiming = undefined;
        held = true;
        if (holder) {
          holder.since = performance.now();
          holding.add(holder);
        }
        // Every use over while the take-back queued.
        if (uses === 0) giveBack();
      })());
    return {
      get ended() {
        return ended;
      },
      handles: (use) => heldFor.includes(use),
      async use<T>(start: () => Promise<T>): Promise<T> {
        uses++;
        try {
          if (!held) await takeBack();
          return await start();
        } finally {
          uses--;
          if (uses === 0 && held) giveBack();
        }
      },
      started() {
        if (uses === 0 && held) giveBack();
      },
      end() {
        ended = true;
        if (held && uses === 0) giveBack();
      },
    };
  }

  // Deliberately NOT `async`: a bad weight is a wiring bug, and it must reach
  // the call site as a throw rather than as a rejected promise nobody may be
  // awaiting yet.
  function acquire(opts?: SlotOptions): Promise<() => void> {
    return lease(
      weightOf(opts),
      classOf(opts),
      opts?.onWait,
      opts?.label,
      opts?.onQueued,
    );
  }

  return {
    acquire,
    run<T>(fn: () => Promise<T>, opts?: SlotOptions): Promise<T> {
      const weight = weightOf(opts); // throws here, not in the promise
      const cls = classOf(opts);
      const heldFor = opts?.heldFor;
      // Without an async context no use could find its slot: an admitted
      // use-scoped body holds its slot throughout, a lazy one holds none.
      if (heldFor && !leaseContextInstalled() && opts?.admit === false) {
        return fn();
      }
      if (heldFor && leaseContextInstalled()) {
        return (async () => {
          const admit = opts?.admit !== false;
          if (admit) {
            const t0 = performance.now();
            await acquireSlot(weight, cls, opts?.onQueued);
            opts?.onWait?.(performance.now() - t0);
          }
          const scoped = useScopedLease(
            weight,
            cls,
            heldFor,
            admit,
            opts?.onWait,
            opts?.onQueued,
            opts?.label,
          );
          try {
            const running = runInLeaseScope(scoped, fn);
            // The body now awaits something: unless that is a use, it holds
            // nothing while it does.
            scoped.started();
            return await running;
          } finally {
            scoped.end();
          }
        })();
      }
      const pending = lease(
        weight,
        cls,
        opts?.onWait,
        opts?.label,
        opts?.onQueued,
      );
      return (async () => {
        const release = await pending;
        try {
          return await fn();
        } finally {
          release();
        }
      })();
    },
    stats: () => {
      const now = performance.now();
      const holders = [...holding]
        .map((h) => ({ label: h.label, heldMs: now - h.since }))
        .sort((a, b) => b.heldMs - a.heldMs);
      return { active, queued: waiters.length, max, holders };
    },
  };
}
