import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { chargeWait } from "@plugins/infra/plugins/runtime-profiler/core";

// A DEDICATED host-wide gate for heavy `git worktree add`/`remove` — deliberately
// SEPARATE from `heavy-read` (infra/host/host-read-pool), not a reuse of it:
//
// - `heavy-read` bounds cheap-ish interactive READS (edited-files, commits-graph,
//   code navigation). A worktree mutation is a heavy WRITE (a ~3.8 s / 77 MB /
//   8385-file checkout, or a ~1.2 s full-tree `rm`). Routing a 3.8 s write through
//   the read gate would head-of-line-block interactive reads behind it — the exact
//   opposite of what we want. Two independent budgets keep read latency and write
//   throughput decoupled.
//
// This gate is a BOUNDARY INVARIANT + containment, not the cost-axis cure: it bounds
// how many full-tree checkouts/removes run at once across ALL worktree backends (the
// spawn job, the reap, manual deletes, and staging-land all live in different
// processes, so only a cross-process flock semaphore can bound them). It is the
// backstop that keeps the box in the flat region — K≤4 concurrent adds stay
// ~baseline, K≥6 degrades ~+75 %/op and drives a +141 % foreground slowdown under a
// 6-way churn. The irreducible per-op cost (the 77 MB working tree) is a separate,
// deeper lever (sparse-checkout). See
// research/perfs/2026-07-02-worktree-mutation-host-gate-DESIGN.md.
//
// Size is declared ONCE in host-admission/core's pool table (`max(2,
// floor(cpus/6))` = 3 on an 18-CPU box), so this pool and the `host-budget` check
// read the same number. NO env override: `size` names the flock SLOT FILES, so it
// MUST be identical in every process — a pure function of stable host facts is
// what prevents a mis-sized backend from silently exceeding the bound.
const { size: mutateSize } = HOST_POOLS["worktree-mutate"];

// The `worktree-mutate-acquire` occupancy gauge is auto-registered by
// `defineHostPool` with TRUE host-wide occupancy.
const gate = defineHostPool({
  id: "worktree-mutate",
  size: mutateSize,
  // `inherit`: decided from measured waits (op log `waits[]` by kind).
  holder: "inherit",
});

// Wrap the heavy `git worktree add`/`remove` subprocess. The acquire-wait is charged
// to the enclosing profiler entry (job/http) so a saturated gate stays attributable
// in get_runtime_profile / slow-ops, mirroring host-read-pool. Context-less callers
// (graphile jobs) fall back to a standalone span inside chargeWait.
//
// `signal` is optional and ambient — a job handler passes its `ctx.signal`. THIS IS
// THE GATE WHERE CANCELLATION MATTERS MOST, and 2026-08-17 is the reason: a handler
// stuck inside this acquire, or inside a `git worktree remove` while holding one of
// its three slots, is not stalling itself — it is stalling worktree checkouts on
// every backend on the machine. Aborting such a handler is meaningless unless the
// abort reaches this wait, so `withWorktreeMutateSlot` forwards it to the pool: a
// pending acquire unwinds with `signal.reason`, and an abort during `fn` hands the
// host slot back immediately instead of when `fn` eventually settles (which, for a
// wedged handler, may be never). `fn` still owns cancelling its own subprocesses —
// pass the same signal to them; `spawnCaptured` accepts one.
export function withWorktreeMutateSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return gate.run(() => fn(), {
    signal,
    onAcquired: (waitMs) => chargeWait("worktree-mutate-acquire", waitMs),
  });
}
