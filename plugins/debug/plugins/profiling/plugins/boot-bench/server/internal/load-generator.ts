import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { heavyReadSlotCount } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { runWithoutProfiling } from "@plugins/infra/plugins/runtime-profiler/core";

// How long each occupant holds a slot per cycle before releasing and immediately
// re-acquiring. Sized to a representative heavy git/fs op (a `git diff`/`status`
// subprocess), so the gate stays contended on a realistic timescale rather than
// churning in microseconds (which the burst would slip through unimpeded).
const OCCUPANT_HOLD_MS = 75;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HostGateLoad {
  /**
   * Stop every occupant and await all loops to drain (in-flight holds released,
   * fds closed → flock slots released). Rejects loudly if any occupant rejected.
   */
  stop(): Promise<void>;
}

/**
 * Drive sustained contention on the host-wide `heavy-read` gate so a benchmarked
 * boot burst is forced onto the real broker wait path — reproducing the
 * cross-worktree storm that serializes loaders on `withHeavyReadSlot`.
 *
 * Occupants run on the LIVE `heavy-read` pool handle — `defineHostPool` is a
 * per-id registry, so occupying `"heavy-read"` returns the very pool
 * `host-read-pool` defined, contending for the IDENTICAL physical flock slot
 * files (`~/.singularity/locks/heavy-read/slot-N.lock`), not a separate gate.
 * Each occupant CYCLES: acquire a slot, hold it for
 * `OCCUPANT_HOLD_MS`, release, immediately re-acquire — looping until stopped.
 * Cycling (rather than holding continuously until stop) is essential: the
 * measured burst's own heavy reads need a slot too, so a permanent hold would
 * deadlock the burst behind occupants that only release after it finishes.
 * Bounded holds keep the gate saturated on average while letting the burst
 * interleave and experience real head-of-line queue-wait — the "waiting, not
 * infinite block" the contention assessment describes. Bodies run inside
 * `runWithoutProfiling` so they hold real slots but emit NO spans into the
 * measured profile. No CPU spin anywhere — the backend is single-threaded, and a
 * spin would fabricate event-loop lag that pure gate contention never produces;
 * occupants are async slot-HOLDERS only.
 *
 * The returned promise resolves only once the gate is first SATURATED — all
 * `min(concurrency, heavyReadSlotCount())` slots held at once — so the caller
 * knows contention is in place before it opens the measurement window. Surplus
 * occupants (when `concurrency` exceeds the slot count) stay parked on the broker
 * slow path, adding realistic extra queue-wait; the barrier targets saturation,
 * not every occupant, so it never waits on a slot that physically cannot be
 * granted.
 */
export async function startHostGateLoad(
  concurrency: number,
): Promise<HostGateLoad> {
  const slots = heavyReadSlotCount();
  // Per-id registry ⇒ this returns the live `heavy-read` handle (defined by
  // host-read-pool at load): the same physical slots, no second semaphore, no
  // duplicate gauge.
  // The holder tier must match host-read-pool's definition of the same id.
  const sem = defineHostPool({
    id: "heavy-read",
    size: slots,
    holder: "inherit",
  });

  // Barrier: resolve once the gate is first fully held (saturated). Capped at the
  // slot count because no more than that many occupants can hold a slot at once.
  const barrierTarget = Math.min(concurrency, slots);
  let firstAcquires = 0;
  let onSaturated!: () => void;
  const saturated = new Promise<void>((resolve) => {
    onSaturated = resolve;
  });

  // Shared stop signal: `stopping` ends the loop; `stopped` interrupts the
  // in-flight hold so stop() returns promptly instead of after a full hold.
  let stopping = false;
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });

  async function occupant(): Promise<void> {
    let counted = false;
    while (!stopping) {
      await runWithoutProfiling(() =>
        sem.run(async () => {
          if (!counted) {
            counted = true;
            firstAcquires += 1;
            if (firstAcquires === barrierTarget) onSaturated();
          }
          await Promise.race([delay(OCCUPANT_HOLD_MS), stopped]);
        }),
      );
    }
  }

  const occupants = Array.from({ length: concurrency }, () => occupant());

  // A zero-slot gate or zero occupancy means there is nothing to saturate.
  if (barrierTarget === 0) onSaturated();
  await saturated;

  return {
    async stop() {
      stopping = true;
      release();
      // Each occupant loop exits after its in-flight hold is interrupted; await
      // them so every slot is released. Reject loudly if any occupant failed (a
      // leaked/broken slot must surface).
      await Promise.all(occupants);
    },
  };
}
