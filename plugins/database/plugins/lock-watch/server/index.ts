import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { closeHeldSession } from "./internal/held-session";
import { lockWatchFirstLookWarmup } from "./internal/first-look-warmup";
import { idleTransactionReports } from "./internal/idle-ended-register";
import { idleTransactionEndedKind, lockHolderKind } from "./internal/kinds";
import { dbLockWatchServed } from "./internal/state";
import { lockWatchJob } from "./internal/watch-job";

export default {
  description:
    "Database lock watch: a per-worktree job that looks at pg_stat_activity + pg_blocking_pids once a minute (Postgres has no change signal for lock waits), on a held direct session that neither a saturated pgbouncer nor a stall of new connections can starve, and names every session holding others back or idle inside a transaction past 60 s by the origin its statement's comment carries — a db-lock-holder report (one row per origin) and the db-lock-watch push value behind the health report's Database row. Each look also probes a new connection; one still unanswered after 5 s gets a snapshot of every busy backend on the cluster, read on the held session, in db.jsonl. Its first look is enqueued at boot by a warm-up, so a restarted backend does not wait for the next minute. It never ends a session. Every session the cluster's idle-in-transaction timeout ends is reported (db-idle-transaction-ended, one row per origin): from the session's own client (database/connection's idleTransactionEndedSink, SQLSTATE 25P03) or, for a session no app client owns, from the watch seeing it gone between two looks with pg_stat_database.sessions_fatal up.",
  register: [lockWatchJob, lockWatchFirstLookWarmup],
  sinkHandlers: [idleTransactionReports],
  onShutdown: closeHeldSession,
  contributions: [
    lockHolderKind,
    idleTransactionEndedKind,
    ...dbLockWatchServed.declare,
  ],
} satisfies ServerPluginDefinition;
