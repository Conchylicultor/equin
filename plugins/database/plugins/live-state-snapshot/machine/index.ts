import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { LIVE_STATE_SNAPSHOT_TABLE } from "@plugins/database/plugins/derived-views/core";

export default {
  description:
    "The L2 snapshot table excluded from a worktree's DB fork — forking is the desktop's, so this half is too.",
  contributions: [
    // The snapshot is a cold-boot ACCELERATOR, not a correctness prerequisite —
    // `initSnapshotSubsystem` degrades to a full recompute when it is absent, so
    // a fork loses startup latency and nothing else.
    //
    // It must not be inherited, because a persisted value is computed FROM other
    // tables and the fork empties several of them (notifications, mail, the
    // observability set). Keeping the snapshot while emptying its sources would
    // make a fresh worktree serve a value that disagrees with the rows behind it
    // — and for a boot-critical resource that stale value is what the very first
    // paint renders. Emptying both makes that mismatch unrepresentable.
    //
    // A table name string rather than a table object: this table is created with
    // `CREATE TABLE IF NOT EXISTS` (see derived-views/core's imperative-tables),
    // not by a drizzle migration, so there is no table object to pass.
    ExcludeFromFork({
      table: LIVE_STATE_SNAPSHOT_TABLE,
      reason:
        "Cold-boot accelerator computed from tables the fork empties; an inherited value would disagree with the rows behind it on first paint.",
    }),
  ],
} satisfies MachinePluginDefinition;
