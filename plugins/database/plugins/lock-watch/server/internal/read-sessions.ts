import { z } from "zod";
import {
  queryOne,
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
         pg_blocking_pids(pid) AS blocked_by,
         (extract(epoch FROM backend_start) * 1000)::float8 AS backend_start_ms
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
    backend_start_ms: z.number().nullable(),
  })
  .transform((r): SessionRow => ({
    pid: r.pid,
    state: r.state,
    applicationName: r.application_name,
    query: r.query,
    xactMs: r.xact_ms,
    stateMs: r.state_ms,
    blockedBy: r.blocked_by,
    backendStartMs: r.backend_start_ms,
  }));

/** One read of the sessions on `client`'s database. */
export function readSessions(client: SqlQueryable): Promise<SessionRow[]> {
  return queryRows(client, { sql: SELECT_SESSIONS, row: SessionRowSchema });
}

// What a look needs to tell a session the idle-in-transaction timeout ended
// from one that merely finished: how many sessions on this database have ended
// on a FATAL so far (a reap counts there; a client closing its connection
// counts as abandoned, `pg_terminate_backend` as killed), and the bound in
// force, in ms (`pg_settings` reports the timeout in ms; 0 = off). A backend's
// session counters are flushed when it exits, and each statement on the held
// session is its own transaction, so every read sees the latest.
const SELECT_SESSION_ENDS = `
  SELECT coalesce((SELECT sessions_fatal FROM pg_stat_database
                    WHERE datname = current_database()), 0)::float8 AS sessions_fatal,
         (SELECT setting FROM pg_settings
           WHERE name = 'idle_in_transaction_session_timeout')::float8 AS idle_timeout_ms`;

export interface SessionEnds {
  sessionsFatal: number;
  idleTimeoutMs: number;
}

/** One read of this database's FATAL session-end count and the idle-in-transaction bound. */
export function readSessionEnds(client: SqlQueryable): Promise<SessionEnds> {
  return queryOne(client, {
    sql: SELECT_SESSION_ENDS,
    row: z
      .object({ sessions_fatal: z.number(), idle_timeout_ms: z.number() })
      .transform((r) => ({
        sessionsFatal: r.sessions_fatal,
        idleTimeoutMs: r.idle_timeout_ms,
      })),
  });
}
