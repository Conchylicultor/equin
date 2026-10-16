import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  chargeWait,
  registerGateGauge,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { AsyncLocalStorage } from "node:async_hooks";

// The host-wide slot count is declared ONCE in host-admission/core's pool table,
// so this pool and the `host-budget` check read the SAME number. `size` names the
// flock SLOT FILES (`slot-0 … slot-(N-1)`), so it MUST be identical in every
// backend — a process sized to 4 only sweeps `slot-0..3` and is blind to one
// holding `slot-7`, silently exceeding the bound. Keeping it a pure function of
// stable host facts in one place is what prevents that.
const { size: heavyReadSize } = HOST_POOLS["heavy-read"];

// Per-process (= per-worktree) local cap on heavy reads. Sits in front of the
// host-wide flock gate so this one backend can only ever present a bounded slice
// of work to the shared queue — preventing a single worktree from monopolizing
// the host gate during a storm (a `main` advance fanning out across ~16
// backends). Default ~ceil(host/2); clamped to 1 ≤ local ≤ host so it never
// over-serializes a legitimate burst and never exceeds (and thus never reorders
// vs.) the host size. Env-overridable for tuning.
function localSize(): number {
  const host = heavyReadSize;
  const env = process.env.SINGULARITY_HEAVY_READ_LOCAL_CONCURRENCY;
  let local = Math.max(1, Math.ceil(host / 2));
  if (env) {
    const n = parseInt(env, 10);
    if (n > 0) local = n;
  }
  return Math.min(host, Math.max(1, local));
}

const perWorktreeGate = createSemaphore(localSize());
const pool = defineHostPool({
  id: "heavy-read",
  size: heavyReadSize,
  // `inherit`: decided from measured waits (op log `waits[]` by kind).
  holder: "inherit",
});

// The host-gate occupancy gauge (`heavy-read-acquire`) is auto-registered by
// `defineHostPool` with TRUE host-wide occupancy. Only the LOCAL per-worktree
// semaphore's gauge is ours to register — its layer name joins to the
// same-named `chargeWait` layer below.
registerGateGauge("heavy-read-local", () => perWorktreeGate.stats());

// Ambient "this async context already holds a slot" flag, making the gate
// REENTRANT. Neither tier's semaphore is reentrant on its own, so without this a
// holder that acquires again parks on a gate that only it can free — with the
// local tier at 2 slots, two nested holders deadlock the entire heavy-read path
// (lived: the warmup executor wraps each warm-up in withHeavyReadSlot, and the
// corpus-index refresh acquires again per parsed file; the moment a SECOND
// corpus warmup existed, both local slots were held by outer wrappers whose
// inner acquisitions waited on themselves, freezing every live-state sub — see
// research/perfs/2026-07-10-read-admit-wedge-stuck-git-loaders.md). Reentrancy
// preserves the budget's meaning — one logical job holds one slot; a nested
// acquire is the SAME job, so admitting it consumes nothing extra — and makes
// the whole deadlock class structurally impossible for any present or future
// caller composition.
const holdingSlot = new AsyncLocalStorage<true>();

/**
 * Admit `fn` to the two-tier heavy-read gate.
 *
 * `signal` is optional and ambient: pass a job handler's `ctx.signal` (or an
 * enclosing request's) and an abort stops the caller waiting for a slot, throwing
 * `signal.reason`. Threaded into BOTH tiers, but they cancel with different
 * sharpness, and the difference is worth knowing rather than papering over:
 *
 *  - The HOST tier honours it properly (`AcquireHooks.signal`): a pending flock
 *    acquire unwinds, and an abort while `fn` runs releases the host slot without
 *    waiting for `fn` to settle. That is the tier that matters, because it is the
 *    one holding a resource every other backend on the box shares.
 *  - The LOCAL tier — `createSemaphore`, an in-process counter+queue — takes no
 *    signal, by design (its consumers elsewhere are request-scoped leases, and the
 *    one case that motivated adding one was deleted). So an abort that lands while
 *    we are queued LOCALLY is not observed until the local gate grants; we then
 *    throw at the top of the body below rather than going on to take a host slot
 *    for a caller that has been written off. The exposure is bounded by the local
 *    queue, which holds nothing host-wide.
 */
export function withHeavyReadSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  // Mirrors `spawnCaptured`: a caller already told to stop never enters a gate.
  signal?.throwIfAborted();
  // Reentrant fast path: already holding in this async context ⇒ same logical
  // job ⇒ run directly, acquire nothing, release nothing. The `throwIfAborted`
  // above covers this path too — an abort must be observed even where there is no
  // gate to wait on, so that a reentrant caller cannot be the one place a
  // cancelled read still runs.
  if (holdingSlot.getStore()) return fn();
  // Two-tier gate: the local per-worktree semaphore wraps OUTSIDE the host-wide
  // flock gate. It bounds how many heavy ops *this* backend can have parked in
  // the shared flock queue at once, so under a cross-worktree storm one worktree
  // can't starve the others — each presents at most `localSize()` waiters before
  // it must first drain locally. Only after passing the local gate does the op
  // compete host-wide for an actual slot.
  //
  // Each tier charges its wait distinctly to the enclosing entry (loader/http):
  // the host-wide cross-process lock-wait under "heavy-read-acquire" and the
  // local in-process queue-wait under "heavy-read-local", so a heavy git/fs
  // loader's span reads as wait-vs-work directly (e.g. edited-files 4032ms = lock
  // 3500 / git diff 532) instead of one opaque number. Context-less callers fall
  // back to a standalone span inside chargeWait.
  return perWorktreeGate.run(
    () => {
      // The local gate has granted. It could not observe an abort while we were
      // queued on it (see the docblock), so this is the first place we can: stop
      // here rather than take a host-wide slot on behalf of a caller that has
      // already been given up on. The local slot is released by the `run` this
      // throws out of.
      signal?.throwIfAborted();
      // The callback runs only once the host slot is held. `defineHostPool`
      // auto-registers the true host-wide occupancy gauge, so there is no local
      // held-count to bracket here; we only mark this async context as holding a
      // slot so a reentrant acquire runs its body directly (the fast path above).
      return pool.run(() => holdingSlot.run(true, fn), {
        signal,
        onAcquired: (waitMs) => chargeWait("heavy-read-acquire", waitMs),
      });
    },
    { onWait: (waitMs) => chargeWait("heavy-read-local", waitMs) },
  );
}

// The host-wide heavy-read gate's slot count (`floor(cpus/4)`). Exposed so callers
// can size a same-named occupant pool to exactly saturate the gate without
// re-deriving the formula.
export function heavyReadSlotCount(): number {
  return heavyReadSize;
}

// The local (per-worktree) tier's slot count (`localSize()`). Exposed so the
// reentrancy regression test can saturate the local gate deterministically.
export function heavyReadLocalSlotCount(): number {
  return localSize();
}

// Queue-depth gauge for the host-wide heavy-read gate: how many callers are
// currently parked waiting for a slot (0 = uncontended). Observability-only,
// surfaced in the health-monitor Backends overview.
export function heavyReadQueueDepth(): number {
  return pool.depth();
}
