import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { join } from "node:path";
import { pgClusterDir } from "@plugins/database/plugins/embedded/data-dirs";

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
export const PGBOUNCER_LOG_FILE = join(PG_DIR, "pgbouncer.log");

/**
 * The PgBouncer pidfile under an arbitrary install root. Used by teardown to find
 * a preview's PgBouncer (rooted at its `/tmp/sgp-XXXXXX` data dir, not this
 * process's own data root). `PGBOUNCER_PID_FILE` is the same path under the dev
 * root.
 */
export function pgbouncerPidFileUnder(root: string): string {
  return join(root, "postgres", "pgbouncer.pid");
}

// The same file under THIS process's data root — through the declared cluster
// dir, like every other path in this file.
export const PGBOUNCER_PID_FILE = join(PG_DIR, "pgbouncer.pid");
