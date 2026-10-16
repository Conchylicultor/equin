import { dlopen } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import {
  createHostSemaphore,
  type AcquireHooks,
  type HostShare,
} from "@plugins/packages/plugins/host-semaphore/server";
import { registerGateGauge } from "@plugins/infra/plugins/runtime-profiler/core";
import type { DataDir } from "@plugins/infra/plugins/paths/core";
import { poolLockDir } from "../../data-dirs";
import { slotFor, type PoolHolder, type Slot } from "./slot";

// The one place a host pool comes into existence. `createHostSemaphore` is
// imported HERE ONLY — the `host-pools-declared` check makes that the structural
// bar, so a 7th pool cannot appear without being declared in the pool table in
// `../../core`.

const { symbols: ffi } = dlopen(
  process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
  { flock: { args: ["i32", "i32"], returns: "i32" } },
);
const LOCK_EX = 2;
const LOCK_NB = 4;

// True iff some process currently holds this slot's flock: a non-blocking
// `flock(LOCK_EX|LOCK_NB)` probe that releases immediately. flock attaches to the
// open file DESCRIPTION, not the process, so this detects a holder even on a
// separate fd in the SAME process (the worktree-op marker test pins that). Open in append mode so a probe never
// truncates a lock file a holder may be using; a non-zero flock return means
// EWOULDBLOCK ⇒ someone else holds it.
function slotHeld(slotPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(slotPath, "a");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // no file ⇒ never held
    throw err;
  }
  try {
    return ffi.flock(fd, LOCK_EX | LOCK_NB) !== 0;
  } finally {
    closeSync(fd); // releases the flock if the probe happened to acquire it
  }
}

// Count a pool's held slots by probing `slot-0 … slot-(size-1)` SERIALLY. Serial
// matters: probing a *free* slot momentarily holds it, so a parallel probe of a
// whole pool could make a concurrent acquirer's `sweepKeep` see zero free slots
// and needlessly fan out. One slot at a time bounds that transient hold to a
// single slot.
function probeOccupancy(slots: DataDir, size: number): number {
  let held = 0;
  for (let i = 0; i < size; i++) {
    if (slotHeld(slots.file(`slot-${i}.lock`))) held++;
  }
  return held;
}

/** A host-wide concurrency pool handle. */
export interface HostPool<H extends PoolHolder = PoolHolder> {
  readonly id: string;
  /** The tier its holder does its held work in (`HostPoolSpec.holder`). */
  readonly holder: H;
  /** The size this process was BUILT for — the pool table's number, and the pool's registry identity. */
  readonly size: number;
  /**
   * The slot set actually being swept right now. Equals `size` except while another
   * checkout has the pool open at a different size, which this process adopts rather
   * than overrules (see `createHostSemaphore`). Observability only.
   */
  liveSize(): number;
  /**
   * The pool's declared flock slot directory (`data-dirs/index.ts`). Exposed so a
   * consumer that must name a specific slot file — the push mutex's `slot-0.lock`,
   * which `worktree`'s op-status probe reads — reaches it through the pool rather
   * than rebuilding the path and hoping the two stay equal.
   */
  readonly slots: DataDir;
  /**
   * Run `fn` holding exactly one slot; release in a `finally`.
   *
   * `fn` is handed the held `Slot`: its `spawn` is the spawn the holder's work
   * goes through, at the pool's holder tier — for a `foreground` pool, out of
   * darwinbg with no way to ask otherwise (see `HostPoolSpec.holder`).
   *
   * `hooks.signal` is threaded straight through to the primitive: it cancels a
   * pending acquire, and an abort while `fn` is still running releases the slot
   * immediately rather than at settle. See `AcquireHooks.signal` — a job handler
   * should pass its `ctx.signal` here, because a caller parked in this acquire is
   * holding a HOST-WIDE flock, so an abort that cannot reach it leaves every other
   * backend on the box waiting on a handler nobody is waiting for any more.
   */
  run<T>(fn: (slot: Slot<H>) => Promise<T>, hooks?: AcquireHooks): Promise<T>;
  /**
   * Acquire a whole share up front (`1 … min(max, size)` slots). `hooks.signal`
   * cancels the acquire only — the returned share's lifetime is the caller's.
   */
  acquireShare(max: number, hooks?: AcquireHooks): Promise<HostShare>;
  /** Callers currently parked on the slow path (queue-depth gauge). */
  depth(): number;
}

/** Declares a host pool: how many holders of its kind may run at once, host-wide. */
export interface HostPoolSpec<H extends PoolHolder = PoolHolder> {
  /**
   * The pool's identity. It must have a lock directory declared for it in this
   * plugin's `data-dirs/index.ts` — which, since those are derived from
   * `HOST_POOLS`, means the pool must already be in the pool table.
   */
  id: string;
  /**
   * How many holders of this kind may run at once, host-wide. A CARDINALITY cap
   * and nothing more: it withholds no capacity from the elastic fleet (`B` is a
   * pure function of host facts), so a holder that ALSO spends a `Grant` unit —
   * the `layout-geometry` check does exactly that — is not paying twice.
   */
  size: number;
  /**
   * The tier the pool's HOLDER does its held work in — required, so every pool
   * decides. The invariant: a holder of a slot others queue on does its held
   * work in the foreground, because every waiter waits out the whole hold and a
   * darwinbg holder runs on the E-cores. `foreground` makes `run`'s `Slot`
   * spawn out of darwinbg (`spawn-priority`'s `spawnInForeground`, a lift around
   * the fork alone — never the holder's whole process, which may be running
   * other work at the same time). `inherit` leaves the tier to the spawner, as
   * before: for a pool nobody measurably waits on, and for the elastic `cpu`
   * pool, which IS the fleet (its interactive lane lifts through
   * `withHostGrant` instead). See
   * research/2026-10-16-global-scarce-slot-holders-run-foreground.md.
   */
  holder: H;
  /**
   * Reserved-floor partition (only the CPU pool, and only `cpu`, today). When
   * set, `backgroundLimit` MUST be supplied — the pool reserves its high
   * `size - backgroundLimit` slots for the `interactive` lane so a saturated
   * `background` lane can never starve interactive work.
   */
  laned?: boolean;
  /**
   * The `background` lane's slot window (`1 … size`), required iff `laned`.
   * Passed straight through to `createHostSemaphore`; the reserved
   * `size - backgroundLimit` slots are interactive-only.
   */
  backgroundLimit?: number;
}

// Registry: one handle per id per process. A repeat `defineHostPool` for the
// same id (e.g. an occupant contending for the SAME physical slots) returns the
// one handle rather than building a second semaphore or double-registering the
// gauge. A mismatching spec is a wiring bug — fail loudly.
const registry = new Map<string, HostPool>();

export function defineHostPool<H extends PoolHolder>(
  spec: HostPoolSpec<H>,
): HostPool<H> {
  const existing = registry.get(spec.id);
  if (existing) {
    if (existing.size !== spec.size || existing.holder !== spec.holder) {
      throw new Error(
        `defineHostPool(${spec.id}): already defined as size ${existing.size}, ` +
          `holder ${existing.holder}, re-defined as size ${spec.size}, holder ${spec.holder}`,
      );
    }
    return existing as HostPool<H>;
  }

  // A `laned` pool MUST carry an explicit `backgroundLimit` — omitting it would
  // silently fall through to `backgroundLimit === size` (no reserved floor),
  // quietly voiding the lane guarantee the `laned` flag promises.
  if (spec.laned && spec.backgroundLimit === undefined) {
    throw new Error(
      `defineHostPool(${spec.id}): laned pool requires an explicit backgroundLimit`,
    );
  }

  // The pool's slot directory is a DECLARATION, not something the primitive
  // derives — that derivation is what silently minted a top-level directory per
  // pool. An id with no declared dir is a wiring bug and fails loudly here rather
  // than quietly creating an unowned directory.
  const slots = poolLockDir(spec.id);
  if (!slots) {
    throw new Error(
      `defineHostPool(${spec.id}): no lock directory is declared for this pool. ` +
        `Add it to the host-admission pool table (HOST_POOLS in core/internal/budget.ts), ` +
        `which is what data-dirs/index.ts derives the locks/<id> declarations from.`,
    );
  }

  const sem = createHostSemaphore({
    slots,
    size: spec.size,
    // Only a laned pool partitions its slots; an un-laned pool leaves
    // `backgroundLimit` at the primitive's default (`= size`, inert).
    ...(spec.laned ? { backgroundLimit: spec.backgroundLimit } : {}),
  });

  // Auto-register the host-gate occupancy gauge under `<id>-acquire` (the same
  // vocabulary `chargeWait` uses, so a snapshot's gate occupancy joins to span
  // waits). `active` is TRUE host-wide occupancy — every backend's held slots,
  // read by probing the flock files — not this process's local held count. This
  // retires the "host-wide occupancy is not cheaply readable" claim the ported
  // pools used to carry.
  // `liveSize()`, not `spec.size`: the pool's slot set is host state, and this
  // process's semaphore adopts the live one when another checkout already has the
  // pool open at a different size. Probing the declared set would then miss the
  // holders on the slots this process is actually sweeping.
  registerGateGauge(`${spec.id}-acquire`, () => ({
    active: probeOccupancy(slots, sem.liveSize()),
    queued: sem.depth(),
    max: sem.liveSize(),
  }));

  const slot = slotFor(spec.holder);
  const pool: HostPool<H> = {
    id: spec.id,
    holder: spec.holder,
    size: spec.size,
    liveSize: () => sem.liveSize(),
    slots,
    run: (fn, hooks) => sem.run(() => fn(slot), hooks),
    acquireShare: (max, hooks) => sem.acquireShare(max, hooks),
    depth: () => sem.depth(),
  };
  registry.set(spec.id, pool);
  return pool;
}

/** One pool's point-in-time host-wide occupancy. */
export interface PoolOccupancy {
  id: string;
  held: number;
  size: number;
}

/**
 * True host-wide occupancy of every registered pool, probed SERIALLY (across
 * pools, and within each pool via `probeOccupancy`) so the transient one-slot
 * hold never overlaps a concurrent acquirer's sweep on more than one slot at a
 * time. Never call from an acquire path — this is for the health-monitor tick
 * and a Debug row.
 */
export async function hostOccupancy(): Promise<PoolOccupancy[]> {
  const out: PoolOccupancy[] = [];
  for (const pool of registry.values()) {
    const size = pool.liveSize();
    out.push({ id: pool.id, held: probeOccupancy(pool.slots, size), size });
    await Promise.resolve(); // yield between pools so a long registry never hogs the loop
  }
  return out;
}
