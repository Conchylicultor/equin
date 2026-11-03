/**
 * The ambient half of a yieldable gate slot: which leases the running code
 * holds, so that code which is about to WAIT on something another caller is
 * doing (`whileWaiting`) can hand them back for the length of the wait.
 *
 * Why it exists: a gate bounds how much work RUNS at once. A body that holds a
 * slot while it only waits — for an in-flight run another caller started (an
 * `inflight` join), say — is not running, yet it keeps the slot. Enough such
 * waiters fill the gate, and every unrelated caller queues behind work none of
 * them depends on: the latency of one slow run becomes the latency of all. A
 * yieldable slot (`SlotOptions.yieldable`) is released while its holder waits
 * and taken back, ahead of every newcomer, when the wait ends — so the gate
 * counts the bodies that run, not the ones that wait.
 *
 * The scope is carried by an injected context runtime (mirroring the profiler's
 * span context): core stays host-neutral, and the server installs an
 * AsyncLocalStorage-backed one at boot (`runtime-profiler/server`'s install). Without it every
 * `whileWaiting` is a passthrough — the slot is simply held, as before.
 */

/** One held yieldable slot, as `whileWaiting` sees it. */
export interface YieldableLease {
  /** The body that took it has settled: nothing to give back or take back. */
  readonly ended: boolean;
  /** A wait starts: give the slot back (the first of overlapping waits does). */
  beginWait(): void;
  /** A wait ends: take the slot back (the last of overlapping waits does). */
  endWait(): Promise<void>;
}

/** The yieldable leases the current async context holds, outermost first. */
export interface LeaseScope {
  readonly leases: readonly YieldableLease[];
}

export interface LeaseContextRuntime {
  run<T>(scope: LeaseScope, fn: () => T): T;
  current(): LeaseScope | undefined;
}

// Default: no ambient context (the web, central, a test that installs none) —
// `whileWaiting` is a passthrough and a yieldable slot is held throughout.
let contextRuntime: LeaseContextRuntime = {
  run: (_scope, fn) => fn(),
  current: () => undefined,
};

export function installLeaseContextRuntime(runtime: LeaseContextRuntime): void {
  contextRuntime = runtime;
}

/** Run `fn` with `lease` added to the ambient scope (nested gates stack). */
export function runInLeaseScope<T>(lease: YieldableLease, fn: () => T): T {
  const parent = contextRuntime.current();
  return contextRuntime.run(
    { leases: parent ? [...parent.leases, lease] : [lease] },
    fn,
  );
}

/**
 * Await `promise` — work some OTHER caller is doing — without holding a gate
 * slot while it is pending: the innermost yieldable slot the current context
 * holds is released for the wait and taken back (at the head of its gate's
 * queue) before this resolves or rejects. Call it only where the caller merely
 * waits; a caller doing the work itself keeps its slot, which is what the gate
 * bounds. Approximate by design: of overlapping waits in one body the last to
 * end takes the slot back (a branch whose wait ended first runs slotless until
 * then), and detached work that inherited the scope yields its body's slot.
 */
export function whileWaiting<T>(promise: Promise<T>): Promise<T> {
  // Only the INNERMOST live lease yields. A body nested in another yieldable
  // body (a gated read inside a gated read) taking several back at once could
  // split the free slots one per body — each holding one, waiting for another,
  // none releasing. Outer leases stay held, as they always were.
  const lease = contextRuntime
    .current()
    ?.leases.findLast((held) => !held.ended);
  // Nothing held: the very promise, so a caller sharing it keeps its identity.
  if (!lease) return promise;
  lease.beginWait();
  return (async () => {
    try {
      return await promise;
    } finally {
      await lease.endWait();
    }
  })();
}
