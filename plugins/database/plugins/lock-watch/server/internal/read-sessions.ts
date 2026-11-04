import { z } from "zod";
import {
  queryRows,
  type SqlQueryable,
} from "@plugins/database/plugins/sql-rows/core";
import type { SessionRow } from "../../core";

// Every client backend on the connection's own database but the reader itself,
// with who each waits on. `pg_blocking_pids` reads the lock manager's shared
// state; once a minute over a few dozen sessions it is nothing. LIMIT: the
// cluster's own max_connections bounds the rows, the limit only states it.
const SELECT_SESSIONS = `
  SELECT pid,
         state,
         coalesce(application_name, '') AS application_name,
         left(coalesce(query, ''), 4000) AS query,
         (extract(epoch FROM (now() - xact_start)) * 1000)::float8 AS xact_ms,
         (extract(epoch FROM (now() - state_change)) * 1000)::float8 AS state_ms,
         pg_blocking_pids(pid) AS blocked_by
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid()
     AND backend_type = 'client backend'
   LIMIT 1000`;

const SessionRowSchema = z
  .object({
    pid: z.number().int(),
    state: z.string().nullable(),
    application_name: z.string(),
    query: z.string(),
    xact_ms: z.number().nullable(),
    state_ms: z.number().nullable(),
    blocked_by: z.array(z.number().int()),
  })
  .transform((r): SessionRow => ({
    pid: r.pid,
    state: r.state,
    applicationName: r.application_name,
    query: r.query,
    xactMs: r.xact_ms,
    stateMs: r.state_ms,
    blockedBy: r.blocked_by,
  }));

/** One read of the sessions on `client`'s database. */
export function readSessions(client: SqlQueryable): Promise<SessionRow[]> {
  return queryRows(client, { sql: SELECT_SESSIONS, row: SessionRowSchema });
}
