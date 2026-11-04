import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { lockHolderKind } from "./internal/kinds";
import { dbLockWatchServed } from "./internal/state";
import { lockWatchJob } from "./internal/watch-job";

export default {
  description:
    "Database lock watch: a per-worktree job that looks at pg_stat_activity + pg_blocking_pids once a minute (Postgres has no change signal for lock waits), on a direct connection that a saturated pgbouncer cannot starve, and names every session holding others back or idle inside a transaction past 60 s by the origin its statement's comment carries — a db-lock-holder report (one row per origin) and the db-lock-watch push value behind the health report's Database row. It never ends a session.",
  register: [lockWatchJob],
  contributions: [lockHolderKind, ...dbLockWatchServed.declare],
} satisfies ServerPluginDefinition;
