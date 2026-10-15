import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  cpuBudget,
  HOST_GRANT_ENV,
  HOST_LANE_ENV,
  type Grant,
  type GrantHooks,
  type Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { withForegroundPriority } from "@plugins/packages/plugins/spawn-priority/server";
import { defineHostPool } from "./pool";

// The laned host CPU pool + the grant that subdivides it. This is where the fleet
// ceiling `B` — host cores vs. how many worker-sized resident sets fit under the
// RAM ceiling, see `PER_UNIT_BYTES` — becomes a real flock pool, and where a
// build/check/push turns one host admission into a bundle of tokens it spends
// across its own fan-out (type-check workers, vite, nested check subprocess)
// without any of them re-acquiring host-wide.

/**
 * The single host CPU pool. `size = B` (the whole elastic fleet), laned so the
 * high `B - backgroundLimit` slots are reserved for the interactive lane and a
 * saturated background (agent) lane can never starve a main build / push.
 */
export const cpuPool = defineHostPool({
  id: "cpu",
  size: cpuBudget().B,
  laned: true,
  backgroundLimit: cpuBudget().backgroundLimit,
});

// Build a grant over a fixed unit count, backed by an in-process semaphore. Used
// both by `withHostGrant` (after a host acquire) and `inheritedGrant` (the
// units already held by the parent). The semaphore is what bounds a holder's
// fan-out to `units`; nothing here touches flock.
function grantOfUnits(units: number, lane: Lane): Grant {
  const sem = createSemaphore(units);
  return {
    units,
    lane,
    run: (fn, opts) => sem.run(fn, { weight: spendOf(opts?.units, units) }),
    env: () => ({ [HOST_GRANT_ENV]: String(units), [HOST_LANE_ENV]: lane }),
  };
}

// How much of a grant one `run` occupies. A nonsense request (fractional, zero,
// negative) is a wiring bug and throws; a request LARGER than the grant is not —
// it is a heavy child meeting a small grant, and the grant is the ceiling, so it
// clamps. See `Grant.run` for why that is the same rule as a reduced grant just
// running the fleet at lower concurrency. Clamping here, once, is also what keeps
// the semaphore's `weight > max` throw unreachable from any grant caller.
function spendOf(want: number | undefined, held: number): number {
  if (want === undefined) return 1;
  if (!Number.isInteger(want) || want < 1) {
    throw new Error(`grant.run: units must be a positive integer, got ${want}`);
  }
  return Math.min(want, held);
}

/**
 * Acquire a host CPU share for `lane` (up to `max` slots), run `fn` with a grant
 * over exactly the slots held, and release the share afterwards. `acquireShare`
 * guarantees `>= 1` slot, so a grant always has `units >= 1`: a 1-unit grant
 * merely serializes the holder's children — no starvation branch, no `min > 1`
 * acquire that could livelock two builds each holding one slot.
 *
 * `opts.hooks` are the acquire's observability seam, forwarded to the pool. They
 * were dropped here for the pool's whole life, which is what made EVERY host-grant
 * wait — build's, check's, push's nested one — unobservable by construction. The
 * pool has always honoured them (`AcquireHooks`); this only stops swallowing them.
 * `lane` is applied AFTER the spread: it is this function's own opt and must win,
 * so a hooks object can never redirect the acquire to the other lane's slot window.
 *
 * `opts.hooks.signal` rides the same spread and cancels a PENDING acquire (the
 * call then throws `signal.reason`). It deliberately does not drop the share
 * mid-`fn` the way `pool.run` does — see `GrantHooks.signal` for why a grant's
 * inheritable tokens make that unsafe.
 *
 * **An interactive grant runs its holder in the foreground.** The lane says a
 * human is blocked on this work, so while `fn` runs the process leaves macOS's
 * darwinbg tier (`withForegroundPriority`), and every child it spawns meanwhile
 * — the push's check subprocess, its type-check worker — inherits that. Without
 * it the lane bought slots but not cores: an agent session is darwinbg as a
 * whole, so a push's lock-holding type-check ran on the E-cores beside the
 * fleet it was meant to outrank, at 718–2211 CPU-s for a 99.9 %-warm program
 * (research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md). Tying
 * it to the lane leaves no spelling for an interactive holder at background
 * priority, and the lane is already bounded (one push at a time, the reserved
 * floor), so this cannot lift the agent fleet.
 */
export async function withHostGrant<T>(
  opts: { lane: Lane; max: number; hooks?: GrantHooks },
  fn: (grant: Grant) => Promise<T>,
): Promise<T> {
  const share = await cpuPool.acquireShare(opts.max, {
    ...opts.hooks,
    lane: opts.lane,
  });
  const grant = grantOfUnits(share.slots, opts.lane);
  try {
    return opts.lane === "interactive"
      ? await withForegroundPriority(() => fn(grant))
      : await fn(grant);
  } finally {
    await share.release();
  }
}

/**
 * The grant this process inherited from its parent via the environment, or
 * `undefined` if there is none (a fresh top-level invocation). Reads
 * `SINGULARITY_HOST_GRANT` (a positive int) and rebuilds an in-process semaphore
 * of that many units — it acquires NOTHING host-wide, because the parent already
 * holds the slots and this child is their only spender. An absent or invalid
 * value returns `undefined` so the caller falls back to `withHostGrant`.
 */
export function inheritedGrant(): Grant | undefined {
  const raw = process.env[HOST_GRANT_ENV];
  if (raw === undefined) return undefined;
  const units = Number(raw);
  if (!Number.isInteger(units) || units < 1) return undefined;
  const lane: Lane =
    process.env[HOST_LANE_ENV] === "interactive" ? "interactive" : "background";
  return grantOfUnits(units, lane);
}
