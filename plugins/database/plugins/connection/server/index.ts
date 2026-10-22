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
// Abandoning a lost connection (detach, hold, never close).
export {
  ABANDON_HOLD_CAP,
  AbandonedClientHold,
  abandonClient,
  assertPgPoolInternals,
} from "./internal/abandon";

export default {
  description:
    "Every backend database connection, built one way: createDbPool / createDbClient give each pool or standalone client a name from the closed pool-name set and a pg.Client subclass that bounds connect() and every query() with a deadline (60 s, widened per scope by withQueryDeadline). A call with no reply rejects with QueryDeadlineExceededError (pool, phase, sql, origin), and its connection is abandoned — detached, held, never closed, since its fd may already be someone else's — and announced on queryDeadlineSink.",
} satisfies ServerPluginDefinition;
