// The grant contract — pure interface + env-var names, so both runtimes (the
// server impl in `../../server`, and the check contract in
// `framework/tooling/core`) share ONE definition without pulling in `bun:ffi`.
//
// A grant is admission returned as *tokens*, not permission. A holder does not
// declare what it fans out into; it SUBDIVIDES the units it was given. Every
// heavy child spends one via `run`; a subprocess child inherits the *number*
// via `env()` and rebuilds its own in-process semaphore, so nothing a holder
// spawns re-acquires host-wide.

import type { Lane } from "./budget";

/** Env var carrying the inherited unit count to a subprocess child (a positive int). */
export const HOST_GRANT_ENV = "SINGULARITY_HOST_GRANT";
/** Env var carrying the inherited lane to a subprocess child. */
export const HOST_LANE_ENV = "SINGULARITY_LANE";

/**
 * A subdivisible admission grant. `units` is how many host CPU slots the holder
 * actually acquired (always `>= 1`). `run` spends one unit through an in-process
 * semaphore (so a holder's own fan-out is bounded to `units`). `env()` is what a
 * subprocess child inherits so its `inheritedGrant()` reconstructs the same
 * budget without acquiring anything host-wide.
 */
export interface Grant {
  readonly units: number;
  /**
   * The lane the holder was admitted in — `interactive` (a human is blocked:
   * main build, push) or `background` (agent build, agent check). It is the ONE
   * classification a holder's children read for everything lane-shaped:
   * which slots it may take, and (through `withHostGrant`'s interactive lift)
   * which scheduling tier the holder's process runs in. A child never re-derives it from the branch — a push checks an agent
   * branch yet is interactive, which is exactly what a branch gate gets wrong.
   */
  readonly lane: Lane;
  /**
   * Spend the holder's units on one heavy child. `opts.units` is how many this
   * child is worth (default 1, a positive integer) — a child whose MEASURED peak
   * is a multiple of the `PER_UNIT_BYTES` quantum declares that multiple, so the
   * quantum can stay the fleet's mean while a heavy consumer pays its own tail
   * where it is measured.
   *
   * The request is CLAMPED to `min(units, grant.units)`, and the clamp lives here
   * because the grant is the ceiling: a 1-unit grant (an inherited
   * `SINGULARITY_HOST_GRANT=1`) runs a 2-unit request at weight 1 rather than
   * waiting for capacity it will never be given. That is the same rule as "a
   * reduced grant just runs the fleet at lower concurrency" — the holder's
   * fan-out narrows, nothing deadlocks, and a weight can never exceed the
   * semaphore's `max`. Declaring more units than the grant holds is therefore
   * legal and means "as heavy as this grant can express".
   */
  run<T>(fn: () => Promise<T>, opts?: { units?: number }): Promise<T>;
  env(): Record<string, string>;
}

/**
 * Observability hooks for a `withHostGrant` acquire. Neither gates behavior; they
 * exist so a caller can make the grant queue visible (a profiler span, an op-log
 * wait segment, a log line) without this plugin knowing about any of that.
 *
 * Structurally the host-semaphore primitive's `AcquireHooks` MINUS `lane` — and
 * that omission is the point. `lane` is `withHostGrant`'s own opt (it selects the
 * reserved-floor slot window, so it DOES gate behavior); leaving it out of the
 * hooks makes it structurally impossible for a caller to smuggle a second,
 * conflicting lane in through the observability channel.
 *
 * Declared here rather than re-exported from `packages/host-semaphore` because a
 * cross-plugin re-export is banned (root CLAUDE.md) and, more concretely, the
 * `host-pools-declared` check makes `@plugins/packages/plugins/host-semaphore/server`
 * an import only `host-admission/server` may name — so a consumer literally cannot
 * reach that barrel to spell the type.
 */
export interface GrantHooks {
  /**
   * Ambient cancellation for the ACQUIRE, mirroring `AcquireHooks.signal`. If it
   * fires while the grant is still queued for host CPU slots, the acquire stops
   * waiting and `withHostGrant` throws `signal.reason`; every `flock-wait` child
   * and fd opened on the way is cleaned up first.
   *
   * Unlike the pool's own `run`, an abort mid-`fn` does NOT drop the share here,
   * and that asymmetry is deliberate. A grant hands out `units` as TOKENS that
   * outlive the acquire — a subprocess child inherits the count through
   * `SINGULARITY_HOST_GRANT` and spends it without re-acquiring — so releasing the
   * host slots while those tokens are still being spent would put work outside the
   * bound rather than merely leaving it unattributed. A single-slot `run` has no
   * such tokens, which is why it can afford the early release and this cannot.
   *
   * Lives on the hooks rather than beside `lane` for one reason: it does not
   * change WHICH slots the acquire may take, only whether the acquire survives.
   */
  signal?: AbortSignal;
  /**
   * The slow path was entered (every slot in the lane's window busy), BEFORE any
   * child is spawned. Never fires on the fast path. Lets a caller *open* a
   * "waiting for a slot" span, which `onAcquired` (fired once, at acquisition)
   * can never express.
   */
  onWaitStart?(): void;
  /**
   * Always fires, fast path or slow, exactly once, at acquisition, before the
   * body runs. Its argument is the milliseconds spent waiting (≈0 on the fast
   * path).
   */
  onAcquired?(waitMs: number): void;
}
