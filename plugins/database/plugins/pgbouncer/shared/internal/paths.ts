import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { join } from "node:path";
import { pgClusterDir } from "@plugins/database/plugins/embedded/data-dirs";
import { serviceLogFile } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";

// PgBouncer's generated config, userlist, log and pidfile live INSIDE the
// embedded cluster's directory. That directory has exactly one owner — the
// `embedded` plugin declares it — so this reads the declaration rather than
// spelling `join(<root>, "postgres")` a second time, which is how the two could
// silently drift apart.
const PG_DIR = pgClusterDir.path;

export const PGBOUNCER_PORT = 6432;

// Same env override as the embedded plugin's PG_SOCKET_DIR — both must resolve to
// the SAME directory (PgBouncer and PG share one socket dir). Lets a packaged
// install keep the Unix socket on a short path (under the 104-byte limit) while
// its data root is a long OS app-data path. Default unchanged ⇒ dev byte-identical.
export const PGBOUNCER_SOCKET_DIR =
  readEnv("PG_SOCKET_DIR") ?? join(PG_DIR, "socket");

export const PGBOUNCER_CONFIG_FILE = join(PG_DIR, "pgbouncer.ini");
export const PGBOUNCER_USERLIST_FILE = join(PG_DIR, "userlist.txt");

/** PgBouncer's service name in the gateway's supervisor (`database.json`). */
export const PGBOUNCER_SERVICE_NAME = "pgbouncer";

/**
 * PgBouncer's log: its stderr, on the gateway's log relay pipe (the start
 * script runs it in the foreground) — the gateway's bounded service channel.
 */
export const PGBOUNCER_LOG_FILE = serviceLogFile(PGBOUNCER_SERVICE_NAME);

/**
 * Where PgBouncer wrote its log (`logfile =`) before the relay, unrotated. Read
 * by the start script's one-shot move of it into {@link PGBOUNCER_LOG_FILE}'s
 * rotation. Delete with that migration once no machine has the file.
 */
export const PGBOUNCER_LEGACY_LOG_FILE = joinAppPath(PG_DIR, "pgbouncer.log");

/**
 * The PgBouncer pidfile under an arbitrary install root. Used by teardown to find
 * a preview's PgBouncer (rooted at its `/tmp/sgp-XXXXXX` data dir, not this
 * process's own data root). `PGBOUNCER_PID_FILE` is the same path under the dev
 * root.
 */
export function pgbouncerPidFileUnder(root: AppPath): AppPath {
  return joinAppPath(root, "postgres", "pgbouncer.pid");
}

// The same file under THIS process's data root — through the declared cluster
// dir, like every other path in this file.
export const PGBOUNCER_PID_FILE = join(PG_DIR, "pgbouncer.pid");
