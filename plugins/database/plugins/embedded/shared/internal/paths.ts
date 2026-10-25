import { join } from "node:path";
import { pgClusterDir } from "../../data-dirs";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// Per-instance port override. Default 5433 (dev cluster). A local release preview
// runs PG alongside the dev cluster on the same host; PG binds no TCP listener,
// but the port still names its Unix socket file, so the preview manager hands
// each preview its own port via this env var.
// Frozen at import time, like every path constant; the launcher/start scripts set
// it in the process env before this module is first imported.
function resolvePgPort(): number {
  const raw = process.env.SINGULARITY_PG_PORT;
  if (raw === undefined) return 5433;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid SINGULARITY_PG_PORT: ${raw}`);
  }
  return n;
}

export const PG_PORT = resolvePgPort();
export const PG_USER = LEGACY_IDS.pgUser;

// The base database, and main's namespace: the one database that is nobody's
// copy. Every other database in the app — a worktree's fork, a served
// composition's — is minted from this one, so the cluster is not usable until
// it exists. Pinned to `MAIN_WORKTREE_NAME` by `paths.test.ts`.
export const PG_BASE_DATABASE = LEGACY_IDS.pgBaseDatabase;

export const PG_MAJOR = 18;
export const MAX_CONNECTIONS = 500;

// The cluster directory is DECLARED in this plugin's `data-dirs/index.ts` (a
// grandfathered `services/postgres` whose `legacyLocation` pins it exactly where
// the running postmaster already has it), so the literal name lives in one place
// and pgbouncer — which writes its own config/pid/log beside the cluster —
// imports that same declaration instead of re-joining the root.
export const PG_DIR = pgClusterDir.path;
export const PG_DATA_DIR = join(PG_DIR, `data-pg${PG_MAJOR}`);

// The PG Unix socket directory. Decoupled from PG_DIR via an env override so a
// packaged install whose data root is a long OS app-data path (macOS
// `~/Library/Application Support/<bundle>/…`) can keep the socket under a SHORT
// path and stay within the 104-byte `sun_path` limit, while the cluster *data*
// stays in app-data. Sockets are ephemeral (remade on each PG start), so a short
// `/tmp`-rooted dir is safe. Default unchanged ⇒ dev byte-identical. The pgbouncer
// plugin reads the SAME env var so both agree on the socket dir. Frozen at import
// time, like every path constant; the launcher sets it before this module loads.
export const PG_SOCKET_DIR =
  process.env.SINGULARITY_PG_SOCKET_DIR ?? join(PG_DIR, "socket");
export const PG_LOG_FILE = join(PG_DIR, "postgres.log");

/**
 * The PG postmaster pidfile under an arbitrary install root. Used by teardown to
 * find a preview's PG (rooted at its `/tmp/sgp-XXXXXX` data dir, not this
 * process's own data root). `PG_PID_FILE` is the same path under the dev root.
 */
export function pgPostmasterPidFile(root: string): string {
  return join(root, "postgres", `data-pg${PG_MAJOR}`, "postmaster.pid");
}

// The same file under THIS process's data root — expressed through the declared
// cluster dir (via PG_DATA_DIR) rather than by re-deriving it from the root.
export const PG_PID_FILE = join(PG_DATA_DIR, "postmaster.pid");
