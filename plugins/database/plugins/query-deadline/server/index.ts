import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { abandonCapKind, queryDeadlineKind } from "./internal/kinds";
import { dbQueryDeadlinesServed } from "./internal/resource";
import {
  registerQueryDeadlineReports,
  unregisterQueryDeadlineReports,
} from "./internal/register";

export { abandonCapKind, queryDeadlineKind } from "./internal/kinds";

export default {
  description:
    "Query-deadline audit: registers a handler on the database plugin's query-deadline seam and turns each announcement into a report — db-query-deadline (error, one row per pool, phase and caller — the query label when there is no caller) when a call on any backend connection — opening it or a query on it — got no answer before its deadline and its connection was abandoned, carrying the connection's transaction state, every other call then in flight, the abandoned connections left in a transaction, and a link to a trace of that instant; db-abandon-cap (error, one rolling row) when the abandoned connections exceed the cap — and keeps the last 20 hits in memory as the db-query-deadlines push resource behind the health report's Database row.",
  contributions: [
    queryDeadlineKind,
    abandonCapKind,
    ...dbQueryDeadlinesServed.declare,
  ],
  onReady: () => {
    registerQueryDeadlineReports();
  },
  onShutdown: () => {
    unregisterQueryDeadlineReports();
  },
} satisfies ServerPluginDefinition;
