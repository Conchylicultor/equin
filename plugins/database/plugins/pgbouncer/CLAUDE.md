# pgbouncer

PgBouncer connection pooler for the embedded Postgres cluster. Fronts PG in transaction mode so worktree app pools share a smaller set of backend connections.

This plugin ships:

- The `@equin/pgbouncer-<platform>` binary as an optionalDependency in `package.json` so `bun install` lands the binary.
- `scripts/start.ts` — standalone lifecycle script that handles binary resolution, config generation, and pgbouncer spawn. Invoked by the gateway's generic service supervisor via `~/.equin/state/db-config/database.json`.
- The `pgbouncer` lockstep group (`package.json` `dependencyPolicy`) keeps the four platforms on one version, and its `wraps` reads the `pgbouncer_<x>_<y>_<z>` tags of github.com/pgbouncer/pgbouncer. The wrappers publish themselves: a daily run of github.com/equinai/pgbouncer-embedded's Build and Publish workflow builds and publishes every new PgBouncer tag, so there is no manual publish step. The wrapper's version IS the PgBouncer version (`@equin/pgbouncer` 1.26.1 wraps PgBouncer 1.26.1; releases up to 1.25.7 numbered their own patches), so the whole version is compared, and a wrapper-only rebuild rides the next upstream release. A PgBouncer release no `@equin/pgbouncer-*` release wraps yet is listed BLOCKED in the weekly upgrade task: the auto-publish has not caught up, so check its latest run, fix it and re-run.
- `shared/` constants (PGBOUNCER_PORT, PGBOUNCER_SOCKET_DIR, config/log/pid paths) reused by the database client layer.

## Connection routing

| Caller | Path | Why |
|---|---|---|
| `app` / `app-background` (Drizzle app queries, one pool per lane) | PgBouncer socket (port 6432), as the lane's role | Most traffic; tx pooling reclaims budget |
| `adminPool`, graphile-worker, pg_dump/pg_restore | Direct PG socket (port 5433) | LISTEN/NOTIFY, advisory locks, subprocesses |

The **advisory locks** row now has a real consumer: `infra/jobs` holds a
session-scoped advisory lock per running job (see
[`jobs/CLAUDE.md`](../../../infra/plugins/jobs/CLAUDE.md)). Session state is the
whole mechanism there, so it must never be moved behind pgbouncer — in transaction
mode the lock would land on whichever backend served the statement and silently
vanish from the next one.

## One server pool per lane

PgBouncer pools by (database, user). Each app connection lane logs in as its own
role — the cluster user for `interactive`, `<cluster user>_background` for
`background` — so each database has one server pool per lane, and leaked or
blocked background connections cannot take the slots interactive work needs
(the 2026-11-03 `/home` outage). `PGBOUNCER_LANES` (`core/internal/lanes.ts`)
is the one table: per-database `pool_size`, cluster-wide
`max_user_connections`. The app sizes its lane pools from it
(`database#machine`). The role itself is created by the app's driver at boot.

The cluster budget is asserted at module load: the lanes' cluster caps plus
`DIRECT_SESSION_RESERVE` (the sessions that bypass PgBouncer: graphile, job
locks, LISTEN, admin) fit Postgres's `max_connections` minus its superuser
reserve. Past a lane's cap PgBouncer queues that lane rather than Postgres
refusing logins.

Design: [`research/2026-11-04-global-pgbouncer-pool-per-lane.md`](../../../../research/2026-11-04-global-pgbouncer-pool-per-lane.md).

## Config

PgBouncer uses a catch-all `* = host=<PG_SOCKET_DIR> port=5433` — any database name routes to the embedded cluster automatically. No SIGHUP needed on worktree create/destroy.

Config files (`pgbouncer.ini`, `userlist.txt`) at `~/.equin/postgres/` are rendered from the lane table (`renderPgbouncerConfig` in `core`, bound to this install's paths by `server`'s `pgbouncerConfigFiles`). Two writers, one rendering: the start script writes them before spawning a fresh daemon, and every backend's database driver calls `machine`'s `convergePgbouncerConfig` at boot — rewrite (atomically) only when the files differ from the rendering, then `SIGHUP` the running daemon (verified to be PgBouncer by its pid's command). The second is what applies a lane-table change: the gateway re-runs the start script only at its own start, and a reattached daemon keeps the config of its own start. With `auth_type = trust` the userlist is what lets a user log in at all: an unlisted user gets `"trust" authentication failed`.

## Lifecycle

The gateway supervisor starts PgBouncer after Postgres (service index 1 in `database.json`). The supervisor's watchdog probes the socket every 2s and attempts one restart on failure.

**Its log is the gateway's service channel**, `PGBOUNCER_LOG_FILE` = `logs/gateway/services/pgbouncer.log` (50 MB × 5): the start script runs PgBouncer in the FOREGROUND (it logs to stderr only when not daemonized), detached into its own session with stdout/stderr on the fd the supervisor's log relay hands it (`--log-fd`, see `gateway/CLAUDE.md` → "the log relay"), and the rendered config names no `logfile` — a file PgBouncer appended to for months reached 1.4 GB. It still writes `pgbouncer.pid`. A foreground PgBouncer that exits before it is ready fails the start at once, naming the log. Behind a gateway older than the relay it daemonizes with `-d` and no log, and says so.

The pre-relay `postgres/pgbouncer.log` is moved into that rotation (as the newest free backup) on the first fresh start under a relay-aware gateway; until then it is a `debt` claim on the cluster's data dir (task-1793827129-t489g4). Converging a running pre-relay PgBouncer onto the new config (no `logfile`) is harmless: it keeps running and stops writing the file.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: PgBouncer connection pooler for the embedded Postgres cluster: path constants for connection routing, and this machine's config rendered from the lane table (one server pool per connection lane).
- Load-bearing: yes
- Server:
  - Uses:
    - `database/embedded.MAX_CONNECTIONS`
    - `database/embedded.PG_PORT`
    - `database/embedded.PG_USER`
  - Exports (values):
    - `PGBOUNCER_LOG_FILE`
    - `PGBOUNCER_PORT`
    - `PGBOUNCER_SERVICE_NAME`
    - `PGBOUNCER_SOCKET_DIR`
    - `pgbouncerConfigFiles`
    - `pgbouncerPidFileUnder`
- Cross-plugin:
  - Imported by:
    - `database`
    - `database/query-deadline`
    - `infra/launcher`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `shared/internal/paths.ts` (debt)
- Machine:
  - Exports (types): `PgbouncerConvergence`
  - Exports (values): `convergePgbouncerConfig`
- Core:
  - Exports (types):
    - `PgbouncerConfigFiles`
    - `PgbouncerConfigInputs`
    - `PgbouncerLane`
    - `PgbouncerLaneSpec`
  - Exports (values):
    - `laneUser`
    - `PGBOUNCER_LANES`
    - `renderPgbouncerConfig`
- Shared:
  - Exports (values):
    - `PGBOUNCER_CONFIG_FILE`
    - `PGBOUNCER_LEGACY_LOG_FILE`
    - `PGBOUNCER_LOG_FILE`
    - `PGBOUNCER_PID_FILE`
    - `PGBOUNCER_PORT`
    - `PGBOUNCER_SERVICE_NAME`
    - `PGBOUNCER_SOCKET_DIR`
    - `PGBOUNCER_USERLIST_FILE`
    - `pgbouncerPidFileUnder`

<!-- AUTOGENERATED:END -->
