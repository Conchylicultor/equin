import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  chargeWait,
  registerGateGauge,
} from "@plugins/infra/plugins/runtime-profiler/core";

// The host-wide slot count is declared ONCE in host-admission/core's pool table,
// so this pool and the `host-budget` check read the SAME number. `size` names the
// flock SLOT FILES (`slot-0 … slot-(N-1)`), so it MUST be identical in every
// backend — a process sized to 1 only sweeps `slot-0` and is blind to one holding
// `slot-1`, silently exceeding the bound. That is why this pool's size is a
// CONSTANT rather than a function of `cpus()` (precedent: `db-fork`): a browser
// launch costs about the same on every box.
const { size: hostSize } = HOST_POOLS["browser-fetch"];

// Per-worktree local gate of exactly ONE. A refresh cadence can enqueue N source
// jobs at once, and without this gate one backend would present N waiters to the
// shared flock queue and starve another worktree's single interactive "Refresh
// now" behind its own batch. One at a time per backend is also honest about what
// a render costs: launch + render + close saturates roughly a core.
const perWorktreeGate = createSemaphore(1);

const pool = defineHostPool({
  id: "browser-fetch",
  size: hostSize,
  // `inherit`: decided from measured waits (op log `waits[]` by kind).
  holder: "inherit",
});

// The host-gate occupancy gauge (`browser-fetch-acquire`) is auto-registered by
// `defineHostPool` with TRUE host-wide occupancy. Only the LOCAL per-worktree
// semaphore's gauge is ours to register — its layer name joins to the same-named
// `chargeWait` layer below.
registerGateGauge("browser-fetch-local", () => perWorktreeGate.stats());

// NOTE: there is deliberately **no `AsyncLocalStorage` reentrancy guard** here,
// unlike `host-read-pool`'s `withHeavyReadSlot`. That guard exists because heavy
// reads genuinely nest (the warmup executor wraps a warm-up that itself parses
// files under the same gate), and with a local tier of 2 the nested acquire
// deadlocked on a gate only its own holder could free. A browser fetch never
// nests in a browser fetch: the body is launch → navigate → serialize → close,
// which calls nothing that could re-enter this gate. Do not copy the ALS block
// across "for symmetry" — it would add an ambient global to guard a shape that
// cannot occur.

/**
 * Run `fn` holding one browser slot: local gate first, then the host-wide one.
 * The slot is held across launch → render → close, because the whole span is
 * what costs the host — but NOT across URL validation, which happens before
 * admission so a refusal never queues behind someone else's render.
 *
 * Each tier charges its wait distinctly to the enclosing entry, so a slow render
 * reads as queue-vs-work rather than one opaque number.
 */
export function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  return perWorktreeGate.run(
    () =>
      pool.run(fn, {
        onAcquired: (waitMs) => chargeWait("browser-fetch-acquire", waitMs),
      }),
    { onWait: (waitMs) => chargeWait("browser-fetch-local", waitMs) },
  );
}

/** Callers currently parked on the host-wide gate (0 = uncontended). */
export function browserFetchQueueDepth(): number {
  return pool.depth();
}
