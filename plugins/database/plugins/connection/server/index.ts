import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// Building a backend database connection: every pool and standalone client
// carries a deadline on connect and on every query.
export {
  createDbPool,
  createDbClient,
  onClientLost,
  queryText,
  type CreateDbPoolOptions,
  type CreateDbClientOptions,
} from "./internal/client";
// A LISTEN session on its own connection (the desktop's `DatabaseDriver.listen`).
export {
  openListenSession,
  type ListenSessionHandlers,
  type OpenListenSessionOptions,
} from "./internal/listen-session";
// The session-held schema-generation locks a deferred contract waits on (the
// desktop's `DatabaseDriver.holdSchemaGeneration` / `awaitGenerationsGone`).
export {
  createSchemaGenerationLocks,
  type SchemaGenerationLocks,
  type SchemaGenerationLocksOptions,
} from "./internal/schema-generation";
// The deadline itself: the bound, its scope, the error, and the seam a missed
// deadline is announced on.
export {
  QUERY_DEADLINE_MS,
  BOOT_DDL_QUERY_DEADLINE_MS,
  queryDeadlineSink,
  withQueryDeadline,
  currentQueryDeadline,
  formatDeadlineLogLine,
  type QueryDeadlineEvent,
} from "./internal/deadline";

// The server's half of a transaction's bound: a session Postgres ended for
// idling inside its transaction (the cluster's
// idle_in_transaction_session_timeout), announced naming the stalled code.
export {
  formatIdleTransactionEndedLogLine,
  idleTransactionEndedSink,
  type IdleTransactionEndedEvent,
} from "./internal/idle-transaction";

export default {
  description:
    "Every backend database connection, built one way: createDbPool / createDbClient give each pool or standalone client a name from the closed pool-name set and a pg.Client subclass that bounds connect() and every query() with a deadline (60 s, widened per scope by withQueryDeadline). A call with no reply rejects with QueryDeadlineExceededError (pool, phase, sql, origin), and its connection is closed — handed back to its pool as broken and its socket destroyed, so Postgres rolls back its transaction and PgBouncer frees its slot — and announced on queryDeadlineSink. A session the server ends for idling inside its transaction (25P03) is announced on idleTransactionEndedSink with the origin and statement of the transaction's last statement, and every later call on that connection fails with IdleTransactionEndedError. Every connection logs in as application_name equin:<pool> (equin-cli:<pool> from a process with no runtime namespace, which reports nothing). Every pool also carries its own connection-error listeners (pool and per client), which report a broken connection once instead of letting it crash the process — so a library handed the pool (graphile-worker) installs none of its own.",
} satisfies ServerPluginDefinition;
