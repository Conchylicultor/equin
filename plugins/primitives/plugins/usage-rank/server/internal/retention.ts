import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _usageStats } from "./tables";

// `usage_stats` is a keyed rollup whose DISTINCT-key set grows without bound:
// nothing deletes the row for a prompt template (or command, or song) the user
// removed from their config, because the ranked things are config/registry
// entries this plugin knows nothing about — there is no parent row and so no FK
// cascade to ride.
//
// The age column is `lastUsedAt` (last use), NOT a creation stamp: we expire
// keys that STOPPED being used, not keys first seen long ago but still hot. A
// key still in use keeps its `lastUsedAt` fresh and is retained forever; one
// abandoned for a year ages out — and by then its decayed score is 0.5^12 ≈
// 1/4096 of its stored value, i.e. already invisible in any ordering. The sweep
// therefore removes only rows that could no longer change a sort result.
//
// `perWorktree: true`: `usage_stats` lives in the per-worktree DB fork, so the
// sweep must run in every worktree backend (each over its own rows).
export const usageStatsRetention = defineRetention({
  table: _usageStats,
  column: "lastUsedAt",
  ttlDays: 365,
  perWorktree: true,
});
