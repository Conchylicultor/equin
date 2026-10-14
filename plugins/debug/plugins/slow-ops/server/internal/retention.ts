import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _slowOpCallers, _slowOps } from "./tables";

// `slow_ops` is a deduped UPSERT aggregate: one row per (operationKind,
// operation, worktree), and every threshold-exceeding occurrence bumps its
// counters and stamps `lastSeenAt`. The DISTINCT-operation set grows without
// bound and has never had a retention bound.
//
// The age column is `lastSeenAt` (last recurrence), NOT `firstSeenAt`: we want
// to expire operations that STOPPED recurring, not rows first seen long ago but
// still hot. A slow op that keeps tripping keeps its `lastSeenAt` fresh and is
// retained; one that stopped ages out 30 days after its last occurrence and is
// re-created from scratch if it ever recurs.
//
// `perWorktree: true`: `slow_ops` lives in the per-worktree DB fork, so the
// sweep must run in every worktree backend (each over its own rows).
export const slowOpsRetention = defineRetention({
  table: _slowOps,
  column: "lastSeenAt",
  ttlDays: 30,
  perWorktree: true,
});

// The same bound per caller row. A caller's `lastSeenAt` is never later than
// its op's (each caller occurrence also bumps the op), so an op's callers age
// out no later than the op itself — and a caller that stopped calling a
// still-hot op ages out on its own.
export const slowOpCallersRetention = defineRetention({
  table: _slowOpCallers,
  column: "lastSeenAt",
  ttlDays: 30,
  perWorktree: true,
});
