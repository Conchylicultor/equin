import {
  MAX_CONNECTIONS,
  PG_PORT,
  PG_USER,
} from "@plugins/database/plugins/embedded/server";
import { renderPgbouncerConfig, type PgbouncerConfigFiles } from "../../core";
import {
  PGBOUNCER_LOG_FILE,
  PGBOUNCER_PID_FILE,
  PGBOUNCER_PORT,
  PGBOUNCER_SOCKET_DIR,
  PGBOUNCER_USERLIST_FILE,
} from "../../shared";

/**
 * This machine's PgBouncer config, rendered from the lane table over this
 * install's paths. The one rendering both writers use — the start script and
 * the backend's converge (`database/pgbouncer#machine`) — so they always agree.
 */
export function pgbouncerConfigFiles(): PgbouncerConfigFiles {
  return renderPgbouncerConfig({
    baseUser: PG_USER,
    // PgBouncer and Postgres share one socket dir.
    socketDir: PGBOUNCER_SOCKET_DIR,
    pgPort: PG_PORT,
    listenPort: PGBOUNCER_PORT,
    userlistFile: PGBOUNCER_USERLIST_FILE,
    logFile: PGBOUNCER_LOG_FILE,
    pidFile: PGBOUNCER_PID_FILE,
    maxConnections: MAX_CONNECTIONS,
  });
}
