import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { chargeWait } from "@plugins/infra/plugins/runtime-profiler/core";

// A DEDICATED host-wide gate for the DB fork's `pg_dump | pg_restore` pipeline —
// until this gate, the fork was the ONLY heavy launch step with zero admission
// control (the job pool alone permitted 4 concurrent dump|restore pairs).
//
// Why a gate at all when the dump/restore CLIENTS are darwinbg-demoted
// (spawn-priority): the heavy server-side work — COPY parsing, index builds —
// runs inside Postgres backends, children of the postmaster, which our spawn
// demotion cannot reach. Bounding concurrent forks caps that un-demotable
// work at ~`size` cores. Size 2 keeps a single/double launch flowing while a
// launch storm queues (attributed, see below) instead of stacking restores.
//
// The acquire-wait is charged to the enclosing profiler entry (the
// `database.fork` job span) as the named `db-fork-acquire` layer, and the gate
// registers a gauge — mirroring worktree-mutate + host-read-pool — so added
// queueing shows up attributed in get_runtime_profile / slow-ops / the flight
// recorder, never as anonymous slowness.
// See research/2026-07-07-global-background-work-priority-isolation.md.
//
// Size is declared ONCE in host-admission/core's pool table (size 2), so this
// pool and the `host-budget` check read the same numbers. NO env override: `size`
// names the flock SLOT FILES, so it MUST be identical in every process — a
// constant (or a pure function of stable host facts) is what prevents a mis-sized
// process from silently exceeding the bound.
const { size: forkSize } = HOST_POOLS["db-fork"];

// The `db-fork-acquire` occupancy gauge is auto-registered by `defineHostPool`
// with TRUE host-wide occupancy.
const gate = defineHostPool({
  id: "db-fork",
  size: forkSize,
  // `inherit`: decided from measured waits (op log `waits[]` by kind).
  holder: "inherit",
});

// `signal` is optional and ambient (no current caller passes one). It cancels a pending acquire and, once held, releases the slot as
// soon as the body is abandoned rather than when it finally settles.
//
// The second half is only honest because `forkDatabase` kills the dump/restore
// children on the same abort: releasing a gate while the heavy work it bounds
// keeps running would silently put that work outside the bound. Whoever passes a
// signal here owes the same to whatever it spawns.
export function withDbForkSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return gate.run(() => fn(), {
    signal,
    onAcquired: (waitMs) => chargeWait("db-fork-acquire", waitMs),
  });
}
