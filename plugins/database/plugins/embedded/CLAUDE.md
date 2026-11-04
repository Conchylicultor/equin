# database

Embedded Postgres for the host. One cluster per machine, multiple databases inside (one per worktree). Replaces user-installed system Postgres.

This plugin ships:

- The `@embedded-postgres/<platform>` binary as an optionalDependency in `package.json` so `bun install` lands the binaries.
- `scripts/start.ts` — standalone lifecycle script that handles binary resolution, dylib symlinks, initdb, pg_ctl start, the base database and the cluster-wide session settings. Invoked by the gateway's generic service supervisor via `~/.equin/state/db-config/database.json`.
- `shared/` constants (PG_PORT, PG_SOCKET_DIR, PG_USER, PG_DATA_DIR, ...) reused by worktree backends, the CLI, and the start script.
- `server/` cluster-level DDL helpers (`dropDatabase`, `databaseExists`) for plugins that manage the worktree DB lifecycle.

## Topology

- **Single embedded cluster, supervised by the gateway.** The gateway's generic service supervisor invokes `scripts/start.ts`, which runs `initdb` on first start (writing to `~/.equin/postgres/data-pg18/`), `pg_ctl start -w` to launch PG, and then `CREATE DATABASE` for the base database if the cluster does not have it. `pg_ctl` daemonizes PG (forks + setsid), so the spawned process exits as soon as PG is ready, leaving PG running with no parent. PG listens on a Unix socket at `~/.equin/postgres/socket/.s.PGSQL.5433`.
- **The base database is born with the cluster.** The base database is the one that is nobody's copy — every other database in the app is minted from it — so the script that brings the cluster up creates it, empty, on every start (reattach included, so a dropped one comes back). Its schema is not this plugin's business: the first backend to boot against it runs the migrations. Before this, nothing anywhere created it, and a fresh clone's first build waited 60s for a fork of a database that did not exist.
- **Session settings are the cluster's.** A setting every session on every database must start with (`CLUSTER_SESSION_SETTINGS` in `shared/` — today `idle_in_transaction_session_timeout` (5 min, `IDLE_IN_TRANSACTION_TIMEOUT_MS`: the bound around app code that stalls between two statements of a transaction — it holds row locks, a lane slot, and if it wrote the live-update watermark of every database; every session it ends is reported, see `database/lock-watch`), `client_connection_check_interval`, so a statement whose client closed its connection — a call lost to its deadline, which `database/connection` closes — is cancelled within 10 s instead of running or waiting on a lock to completion, and `log_connections` — `receipt,setup_durations`, so a connection stall shows in Postgres's log whether the postmaster accepted the socket and how long the backend took to be ready) is written by the start script with `ALTER SYSTEM` + `pg_reload_conf()` on every start, reattach included — one writer per cluster start. The same start `ALTER DATABASE … RESET`s a cluster setting on every database still carrying its own copy, which would override the cluster's value there (the first, per-database version of the idle-in-transaction timeout left one on every database that booted it). A setting the cluster must no longer carry goes in `RETIRED_CLUSTER_SETTINGS`: the start `ALTER SYSTEM RESET`s it and resets its per-database copies the same way (none today). A changed setting reaches a running cluster on the next gateway start (or `cluster-settings.test.ts`, which applies the same values). Never `ALTER DATABASE … SET` it from a backend's boot: every process booting the DB layer (the server and each supervised exec child) would write the same `pg_db_role_setting` row, and concurrent boots fail with `tuple concurrently updated`; a fork would not carry it either.
- **Cluster shared by every worktree backend.** Isolation comes from per-worktree databases inside the cluster, not separate clusters. Worktree backends connect via `~/.equin/postgres/socket` on port 5433 (see `server/src/db/client.ts`).
- **PG outlives gateway and central restarts.** Because PG is detached, both `./equin build` (which restarts central) and `./equin start` (which rebuilds + relaunches the gateway) leave PG untouched. Worktree backends keep their pools alive across both blips. A reattach check (pidfile + socket dial) lets a freshly-started gateway pick up an already-running PG instead of trying to spawn a duplicate.
- **Binaries from `embedded-postgres` npm.** The package vendors PG 18 binaries per platform via `@embedded-postgres/<platform>` optionalDependencies. The package only ships `postgres`, `initdb`, and `pg_ctl`. Client tools (`pg_isready`, `psql`) are replaced with `pg.Client` calls / `net.Dial` socket pings; `pg_dump`/`pg_restore` are vendored by the sibling [`client-tools`](../client-tools/CLAUDE.md) plugin, built from the same Postgres release — the `postgres-release` lockstep group (in client-tools' `package.json`) makes the npm updater move both together, and `deps-npm:groups-coherent` fails when the lock disagrees.
- **Lazy `dylib` symlinks.** The platform tarballs ship versioned dylibs (e.g. `libicudata.77.1.dylib`) but PG's runtime loader expects unversioned aliases. The start script reads the package's `pg-symlinks.json` manifest and creates the missing symlinks on first use.
- **PgBouncer pooling.** The sibling `plugins/database/plugins/pgbouncer/` plugin fronts this cluster with PgBouncer in transaction mode. App query pools connect through PgBouncer (port 6432); admin, worker, and subprocess connections bypass it and go direct to PG (port 5433).

## Its log

`PG_LOG_FILE` is the gateway's service channel `logs/gateway/services/postgres.log` (50 MB × 5), never a file Postgres owns: the start script gives `pg_ctl -l` the relay pipe (`/dev/fd/3`, the fd the supervisor hands it with `--log-fd` — see `gateway/CLAUDE.md` → "the log relay"), so the postmaster and every backend write their stderr into the gateway's rotating writer. The pre-relay `postgres/postgres.log` (`PG_LEGACY_LOG_FILE`, 1.7 GB by 2026-11-04) is moved into that rotation as its newest free backup on the first FRESH start under a relay-aware gateway (`adoptLegacyLog`), so it ages out instead of vanishing; a reattached cluster keeps writing it until it restarts (a `debt` claim, task-1793827129-t489g4). Behind a gateway older than the relay, the script says so and logs to the legacy file.

## Connection routing (server-side)

Worktree backends read connection params from `~/.equin/state/db-config/database.json` (auto-generated on first `./equin start`). The default config points at the embedded cluster's Unix socket on port 5433. To use system PG instead, edit the config file — see [`docs/setup.md`](../../../../docs/setup.md).

`db-fork.ts` and the build's `waitForDatabase` explicitly set `PGHOST`/`PGPORT` in subprocess env so libpq tools find the correct instance.

## Status

`GET /gateway/services/postgres/status` returns the gateway supervisor's state for the postgres service:

```json
{ "name": "postgres", "state": "running" | "starting" | "stopped" | "crashed",
  "error": "start command failed: exit status 1: initdb: error: cannot be run as root" }
```

`error` is optional and present only on a failure — a `running` service's JSON is exactly the two fields. It carries the supervisor's recorded reason for the crash (start-command stderr, or the readiness timeout), so `crashed` is a state a consumer can act on rather than a bare fact. A cluster that fails to start at *gateway boot* never reaches this endpoint at all: the gateway exits non-zero instead of listening (see [`gateway/CLAUDE.md`](../../../../gateway/CLAUDE.md), "Service supervision"). This field is for the cluster that died *after* a healthy start.

## What this plugin does NOT do

- Manage PgBouncer (deferred to v2).
- Create a WORKTREE's database — that's `plugins/database/plugins/fork/`, a job that copies the base database with pg_dump/pg_restore. This plugin mints only the base database every fork is made from; it never decides what a namespace's data should be.
- Expose a `pg` client. Sibling code that needs PG access continues to import from `@plugins/database/server`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Embedded Postgres binaries for the gateway-owned cluster. Provides shared connection constants used by every worktree backend.
- Load-bearing: yes
- Cross-plugin:
  - Imported by:
    - `database/pgbouncer`
    - `database/query-deadline`
    - `debug/sentinel`
    - `infra/launcher`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `shared/internal/paths.ts` (debt)
- Server:
  - Exports (values):
    - `MAX_CONNECTIONS`
    - `PG_DATA_DIR`
    - `PG_DIR`
    - `PG_LOG_FILE`
    - `PG_PORT`
    - `PG_SOCKET_DIR`
    - `PG_USER`
    - `pgPostmasterPidFile`
- Shared:
  - Exports (types): `ClusterSettingsClient`
  - Exports (values):
    - `applyClusterSettings`
    - `CLIENT_CONNECTION_CHECK_INTERVAL_MS`
    - `CLUSTER_SESSION_SETTINGS`
    - `IDLE_IN_TRANSACTION_TIMEOUT_MS`
    - `MAX_CONNECTIONS`
    - `PG_BASE_DATABASE`
    - `PG_DATA_DIR`
    - `PG_DIR`
    - `PG_LOG_FILE`
    - `PG_MAJOR`
    - `PG_PID_FILE`
    - `PG_PORT`
    - `PG_SOCKET_DIR`
    - `PG_USER`
    - `pgPostmasterPidFile`
    - `RETIRED_CLUSTER_SETTINGS`

<!-- AUTOGENERATED:END -->
