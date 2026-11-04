// One PgBouncer server pool per connection LANE. PgBouncer keys a pool by
// (database, user), and the catch-all `*` database entry cannot alias a
// database per lane without one config entry per worktree, so each lane logs in
// as its own role. The interactive lane is the cluster user itself; the
// background lane is a login role that runs every session as the cluster user
// (`ALTER ROLE … SET role`, created by the app's driver at boot), so ownership
// and privileges are the cluster user's while `session_user` — what
// `pg_stat_activity.usename` shows — names the lane.
//
// Why: on 2026-11-03 background connections lost to a deadline were abandoned
// (never closed, the rule then) and kept their PgBouncer server slots while
// they sat idle in a transaction. With one pool per database, 16 of them took
// every slot and `/home`'s `SELECT 1` queued forever. Lost connections are
// closed now, but a background lane can still fill its slots with work that is
// merely slow or blocked; with a pool per lane, that exhausts only the
// background pool — still loudly: its calls miss their deadline on the
// `app-background` pool. This is isolation, not headroom.
// See research/2026-11-04-global-pgbouncer-pool-per-lane.md.

export type PgbouncerLane = "interactive" | "background";

export interface PgbouncerLaneSpec {
  /** Appended to the cluster user to name the lane's login role. */
  readonly userSuffix: string;
  /**
   * Server connections per DATABASE for this lane — PgBouncer's per-user
   * `pool_size`, and also the size of the app's pool for the lane
   * (`database#machine` reads it from here, so the two cannot disagree).
   */
  readonly poolSize: number;
  /**
   * Server connections for this lane across EVERY database — PgBouncer's
   * `max_user_connections`. Past it PgBouncer queues the lane's clients rather
   * than letting Postgres refuse logins: the cluster budget below.
   */
  readonly clusterCap: number;
}

export const PGBOUNCER_LANES: Readonly<
  Record<PgbouncerLane, PgbouncerLaneSpec>
> = {
  interactive: { userSuffix: "", poolSize: 8, clusterCap: 160 },
  background: { userSuffix: "_background", poolSize: 10, clusterCap: 120 },
};

const LANES = Object.keys(PGBOUNCER_LANES) as PgbouncerLane[];

/** The login role a lane connects as, for a cluster user. */
export function laneUser(baseUser: string, lane: PgbouncerLane): string {
  return baseUser + PGBOUNCER_LANES[lane].userSuffix;
}

// ─── The cluster's connection budget ─────────────────────────
//
// Postgres's `max_connections` is shared by every worktree on the machine.
// PgBouncer's server connections are bounded per lane by `clusterCap`; what
// remains is for the sessions that bypass PgBouncer (graphile's runner and
// enqueue pools, job locks, the change-feed LISTEN, admin, schema-generation
// locks — at most ~32 per serving backend; 57 in use cluster-wide when this was
// sized). Postgres keeps `superuser_reserved_connections` (default 3) back.
const SUPERUSER_RESERVED_CONNECTIONS = 3;
export const DIRECT_SESSION_RESERVE = 217;

/**
 * Throws unless the lanes' cluster caps plus the direct-session reserve fit the
 * cluster's `max_connections`, and every lane's pool fits its own cap. Run when
 * the config is rendered, so no PgBouncer is ever configured past the budget.
 */
export function assertLaneBudget(maxConnections: number): void {
  const laneCaps = LANES.reduce(
    (sum, lane) => sum + PGBOUNCER_LANES[lane].clusterCap,
    0,
  );
  if (
    laneCaps + DIRECT_SESSION_RESERVE >
    maxConnections - SUPERUSER_RESERVED_CONNECTIONS
  ) {
    throw new Error(
      `PgBouncer lane budget exceeds the cluster: lane caps (${laneCaps}) + direct-session reserve ` +
        `(${DIRECT_SESSION_RESERVE}) > max_connections (${maxConnections}) - superuser reserve ` +
        `(${SUPERUSER_RESERVED_CONNECTIONS}).`,
    );
  }
  for (const lane of LANES) {
    const spec = PGBOUNCER_LANES[lane];
    if (spec.poolSize > spec.clusterCap) {
      throw new Error(
        `PgBouncer lane ${lane}: pool_size (${spec.poolSize}) exceeds its cluster cap (${spec.clusterCap}).`,
      );
    }
  }
}

// ─── The generated config ────────────────────────────────────

/** Where things are, for one PgBouncer: the inputs of its config. */
export interface PgbouncerConfigInputs {
  /** The cluster user; each lane's role is derived from it (`laneUser`). */
  readonly baseUser: string;
  /** The directory holding both Postgres's and PgBouncer's sockets. */
  readonly socketDir: string;
  readonly pgPort: number;
  readonly listenPort: number;
  readonly userlistFile: string;
  readonly pidFile: string;
  /** The cluster's `max_connections`, which the lanes are budgeted against. */
  readonly maxConnections: number;
}

export interface PgbouncerConfigFiles {
  /** `pgbouncer.ini`. */
  readonly ini: string;
  /** `userlist.txt` — with `auth_type = trust`, the users that may log in at all. */
  readonly userlist: string;
}

/**
 * The whole PgBouncer config, rendered from the lane table. Pure and
 * deterministic: the start script and every backend render the same bytes, so
 * converging an already-current daemon is a no-op. There is no
 * `default_pool_size`: only lane users can log in (the userlist), and each has
 * its own. And no `min_pool_size`: it would pin idle server connections in
 * every (database, lane) pool used in the last hour — worktrees, forks,
 * throwaway test databases — against the lanes' cluster caps.
 *
 * And no `logfile`: PgBouncer runs in the foreground with its stderr on the
 * gateway's log relay (the start script), so its log is the gateway's bounded
 * service channel, never a file it appends to forever.
 */
export function renderPgbouncerConfig(
  inputs: PgbouncerConfigInputs,
): PgbouncerConfigFiles {
  assertLaneBudget(inputs.maxConnections);
  const users = LANES.map((lane) => {
    const spec = PGBOUNCER_LANES[lane];
    return `${laneUser(inputs.baseUser, lane)} = pool_size=${spec.poolSize} max_user_connections=${spec.clusterCap}`;
  }).join("\n");
  const ini = `[databases]
* = host=${inputs.socketDir} port=${inputs.pgPort}

[users]
${users}

[pgbouncer]
listen_addr =
unix_socket_dir = ${inputs.socketDir}
listen_port = ${inputs.listenPort}
pool_mode = transaction
max_client_conn = 200
auth_type = trust
auth_file = ${inputs.userlistFile}
pidfile = ${inputs.pidFile}
`;
  const userlist = LANES.map(
    (lane) => `"${laneUser(inputs.baseUser, lane)}" ""\n`,
  ).join("");
  return { ini, userlist };
}
