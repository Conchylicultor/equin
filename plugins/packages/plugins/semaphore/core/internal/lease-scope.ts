/**
 * The ambient half of a use-scoped gate slot (`SlotOptions.heldFor`): which
 * slots the running code may hold, so that a leaf use of a resource — a DB
 * statement, a file call, a child process (`usingSlot`) — can hold its slot for
 * exactly the length of that use, and nothing else can.
 *
 * Why: a gate bounds how much work RUNS at once. A body that held its slot for
 * its whole run held it too while it only waited — on another caller's flight,
 * a mutex, a worker thread's answer, a child process — and enough such waiters
 * filled the gate in front of unrelated callers (the live read gate, main,
 * 2026-11-03 → 2026-11-18). The fix used to be one opt-out per kind of wait
 * (`whileWaiting`), and each restart found the next kind. Now a use-scoped slot
 * is RELEASED by default and held only inside a declared use: waiting on
 * anything else holds nothing, with no call site to remember.
 *
 * The scope is carried by an injected context runtime (mirroring the profiler's
 * span context): core stays host-neutral, and every Bun host installs an
 * AsyncLocalStorage-backed one at boot — a worktree server in
 * `runtime-profiler/server`'s install, central in `central-core/bin`. Without
 * one no use could find its slot, so a use-scoped gate falls back to holding
 * the slot for the whole body (`leaseContextInstalled`) — a browser host.
 *
 * research/2026-11-18-network-read-admit-use-scoped-slots.md
 */

/**
 * What a use-scoped slot is held for: a LEAF use of a scarce resource — one
 * whose completion waits on no in-process gate (a DB statement and the pool
 * connection it runs on, one file call, one child process). Closed, so a new
 * kind of held work is a reviewed change here; every holder finishing on its
 * own is what keeps use-scoped gates free of wait-for cycles.
 */
export type SlotUse = "db" | "fs" | "spawn";

/** One use-scoped slot in scope, as `usingSlot` sees it. */
export interface UseLease {
  /** The body that took it has settled: it holds nothing any more. */
  readonly ended: boolean;
  /** Whether this slot is held for `use`. */
  handles(use: SlotUse): boolean;
  /** Run `start` holding the slot (taken back first when not held). */
  use<T>(start: () => Promise<T>): Promise<T>;
}

/** The use-scoped leases the current async context runs under, outermost first. */
export interface LeaseScope {
  readonly leases: readonly UseLease[];
}

export interface LeaseContextRuntime {
  run<T>(scope: LeaseScope, fn: () => T): T;
  current(): LeaseScope | undefined;
}

let contextRuntime: LeaseContextRuntime | null = null;

/**
 * Install the async context runtime (a host does it once, at boot), or remove
 * it with `null` — a test suite installs one for its own tests and removes it
 * after, so another suite sharing the process sees the host it asked for.
 */
export function installLeaseContextRuntime(
  runtime: LeaseContextRuntime | null,
): void {
  contextRuntime = runtime;
}

/** Whether a use can find its slot (an async context runtime is installed). */
export function leaseContextInstalled(): boolean {
  return contextRuntime !== null;
}

/** Run `fn` with `lease` added to the ambient scope (nested gates stack). */
export function runInLeaseScope<T>(lease: UseLease, fn: () => T): T {
  if (!contextRuntime) return fn();
  const parent = contextRuntime.current();
  return contextRuntime.run(
    { leases: parent ? [...parent.leases, lease] : [lease] },
    fn,
  );
}

/**
 * Run `start` — ONE leaf use of a resource of kind `use` — holding, for its
 * length, the innermost live slot in scope held for that kind. A slot given
 * back is taken back at the head of its gate's queue first (the body was
 * admitted before every caller queued now). Outside any such scope it simply
 * runs `start`.
 *
 * Only the resource primitives call it (the `semaphore/slot-use-site` lint;
 * each call site is a sanctioned exemption): `start` must wait on nothing but
 * the resource itself, or a holder could wait on a gate whose holders wait on
 * it.
 */
export function usingSlot<T>(
  use: SlotUse,
  start: () => Promise<T>,
): Promise<T> {
  const leases = contextRuntime?.current()?.leases;
  if (leases) {
    for (let i = leases.length - 1; i >= 0; i--) {
      const lease = leases[i]!;
      if (!lease.ended && lease.handles(use)) return lease.use(start);
    }
  }
  return start();
}
