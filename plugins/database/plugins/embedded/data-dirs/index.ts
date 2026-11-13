import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The embedded Postgres cluster directory: the PG data dir, the Unix socket
 * dir, `postgres.log` — and, beside them, PgBouncer's generated `pgbouncer.ini`
 * / `userlist.txt` / `pgbouncer.log` / `pgbouncer.pid`. One directory, two
 * plugins: this plugin declares it, and `database/pgbouncer` imports the
 * declaration rather than re-deriving the path (which is what it did before,
 * as a second `join(<root>, "postgres")` that could silently drift).
 */
export const pgClusterDir = defineDataDir({
  kind: "services",
  name: "postgres",
  owner: "database/embedded",
  description:
    "The host's embedded Postgres cluster: PG data dir, socket dir, server log, and the PgBouncer config/pid/log written beside them",
  // The cluster holds EVERY worktree's database. There is no other copy of any
  // of it, and no rebuild — reclaiming it is data loss, not a re-derivation.
  reclaim: {
    kind: "never",
    reason:
      "the cluster is the only copy of every worktree database; deleting it destroys all app data",
  },
  // PERMANENT, not a to-do. The cluster is ~35 GB of live data with a running
  // postmaster holding it open: relocating it means stopping the cluster (and
  // with it every backend on the host), so the entry stays where the postmaster
  // already has it. Grandfathered deliberately, not "not yet moved".
  legacyLocation: {
    path: "postgres",
    reason:
      "a live ~35 GB cluster with a running postmaster; moving it requires full cluster downtime, so it is grandfathered in place",
  },
  // Postgres and PgBouncer log through the gateway's service log relay now
  // (logs/gateway/services/). These are their pre-relay files, moved into that
  // rotation on the first fresh start under a relay-aware gateway.
  // The PG data directory (`data-pg<major>`) is Postgres's own format: hundreds
  // of database dirs, and no log — logging_collector is off, so the server
  // logs only to the stderr the gateway's relay rotates.
  notLogs: [
    {
      pattern: "data-pg*",
      reason:
        "Postgres's data directory: logging_collector is off, so the server writes no log here — its output goes through the gateway's service log relay",
    },
  ],
  logs: [
    {
      pattern: "postgres.log",
      bound: {
        kind: "debt",
        reason:
          "pre-relay `pg_ctl -l` file, still written by a cluster started before the relay; moved into the relay's rotation on its next fresh start",
        task: "task-1793827129-t489g4",
      },
    },
    {
      pattern: "pgbouncer.log",
      bound: {
        kind: "debt",
        reason:
          "pre-relay `logfile`, still written by a PgBouncer started before the relay; moved into the relay's rotation on its next fresh start",
        task: "task-1793827129-t489g4",
      },
    },
  ],
});

export default [pgClusterDir];
