import { z } from "zod";
import {
  queryOne,
  queryRows,
  type SqlQueryable,
} from "@plugins/database/plugins/sql-rows/core";

/** One backend of the cluster that is doing something (not idle). */
export interface ClusterSession {
  pid: number;
  datname: string | null;
  usename: string | null;
  backendType: string;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  /** How long its current statement (or, without one, the backend) has run. */
  runningMs: number | null;
  query: string;
}

/** What the whole cluster was doing at one instant. */
export interface ClusterActivity {
  backends: number;
  maxConnections: number;
  busy: ClusterSession[];
}

/** The busy backends one snapshot lists; the count says how many there were. */
export const CLUSTER_BUSY_MAX = 30;

// Every database, every backend type (the checkpointer and autovacuum
// included): a stall of NEW connections is a cluster fact, and whatever holds
// the postmaster or a shared lock back can be on any database. Idle backends
// are only counted. Oldest work first.
const SELECT_BUSY = `
  SELECT pid,
         datname,
         usename,
         backend_type,
         state,
         wait_event_type,
         wait_event,
         (extract(epoch FROM (now() - coalesce(query_start, backend_start))) * 1000)::float8 AS running_ms,
         left(coalesce(query, ''), 300) AS query
    FROM pg_stat_activity
   WHERE pid <> pg_backend_pid()
     AND coalesce(state, '') <> 'idle'
     AND (state IS NOT NULL OR wait_event_type IS NOT NULL)
   ORDER BY coalesce(query_start, backend_start) NULLS LAST
   LIMIT ${CLUSTER_BUSY_MAX}`;

const SELECT_COUNTS = `
  SELECT count(*)::int AS backends,
         current_setting('max_connections')::int AS max_connections
    FROM pg_stat_activity`;

const BusyRowSchema = z
  .object({
    pid: z.number().int(),
    datname: z.string().nullable(),
    usename: z.string().nullable(),
    backend_type: z.string(),
    state: z.string().nullable(),
    wait_event_type: z.string().nullable(),
    wait_event: z.string().nullable(),
    running_ms: z.number().nullable(),
    query: z.string(),
  })
  .transform((r): ClusterSession => ({
    pid: r.pid,
    datname: r.datname,
    usename: r.usename,
    backendType: r.backend_type,
    state: r.state,
    waitEventType: r.wait_event_type,
    waitEvent: r.wait_event,
    runningMs: r.running_ms,
    query: r.query,
  }));

const CountsSchema = z.object({
  backends: z.number().int(),
  max_connections: z.number().int(),
});

/** One read of what every backend of `client`'s cluster is doing. */
export async function readClusterActivity(
  client: SqlQueryable,
): Promise<ClusterActivity> {
  const counts = await queryOne(client, {
    sql: SELECT_COUNTS,
    row: CountsSchema,
  });
  const busy = await queryRows(client, {
    sql: SELECT_BUSY,
    row: BusyRowSchema,
  });
  return {
    backends: counts.backends,
    maxConnections: counts.max_connections,
    busy,
  };
}
