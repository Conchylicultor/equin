# Embedded Postgres + PgBouncer

## Context

Singularity hits "too many clients" PG exhaustion. Each worktree process opens ~7 PG connections (app pool max 5, admin pool 1, graphile-worker Runner + WorkerUtils each holding a LISTEN connection). With ~15–20 active worktrees against PG default `max_connections=100`, exhaustion is unavoidable.

Beyond the immediate fix, the eventual desktop deploy (Electron-style, no user PG setup) requires bundling PG anyway. Solving both at once: **single embedded PG instance, multi-DB inside it (preserves the existing one-DB-per-worktree model), fronted by PgBouncer in transaction mode for connection pooling. Owned by the central runtime — first central plugin to supervise child processes.**

User decisions (from clarifying questions):
- Binaries: `@embedded-postgres/*` npm packages for PG; custom postinstall for PgBouncer.
- Migration: auto-detect existing system-PG and auto-migrate on first run.
- `CREATE DATABASE TEMPLATE` fork speedup: deferred to a v2.

## Architecture

### Connection routing

| Caller | Path | Why |
|---|---|---|
| `pool` (app queries, drizzle) | PgBouncer transaction socket | Most traffic; pooling reclaims the connection budget |
| `adminPool` (`CREATE/DROP DATABASE`) | Direct PG socket | Admin ops on `postgres` DB, max:1, doesn't fit pooling |
| graphile-worker Runner + WorkerUtils | Direct PG socket | Uses LISTEN/NOTIFY + advisory locks — **incompatible with tx pooling** |
| `db-fork.ts` (`pg_dump`/`pg_restore`) | Direct PG socket | Subprocesses; tx pooling adds nothing |
| drizzle-kit migration generation | Direct PG socket | One-shot subprocess in `./equin build` |

Single PgBouncer instance in transaction mode. graphile-worker bypasses entirely — no second session-mode PgBouncer (added ops surface not worth it).

### File layout

```
plugins/infra/plugins/database/
  CLAUDE.md
  central/
    index.ts                    # CentralPluginDefinition — onReady/onShutdown
    internal/
      paths.ts                  # ~/.singularity/postgres/* path constants
      binaries.ts               # Resolve PG (from @embedded-postgres/*) + PgBouncer
      initdb.ts                 # First-run initdb, version-stamp check
      supervisor.ts             # Spawn + watchdog (pg_isready poll, crash flag)
      pgbouncer-config.ts       # Generate pgbouncer.ini + userlist.txt fresh each boot
      migrate-from-system.ts    # Auto-detect + migrate existing system PG on first run
```

```
~/.singularity/postgres/
  data-pg18/                    # Initdb data dir (version-stamped)
  socket/                       # PG Unix socket dir (.s.PGSQL.5433)
  pgbouncer.ini                 # Regenerated each central boot
  userlist.txt                  # PgBouncer auth_file (single dummy entry, trust auth)
  postgres.log
  pgbouncer.log
  pgbouncer.pid

~/.singularity/sockets/
  pgbouncer-tx.sock             # NEW — app pool destination
  central.sock                  # (existing)
  <worktree>.sock               # (existing)
```

### Env vars injected by gateway

The gateway passes these to every worktree backend (alongside `SOCKET_PATH`, `SINGULARITY_WORKTREE`):

| Var | Value |
|---|---|
| `SINGULARITY_PG_SOCKET_DIR` | `~/.singularity/postgres/socket` |
| `SINGULARITY_PG_PORT` | `5433` (avoid colliding with system PG on 5432) |
| `SINGULARITY_PGBOUNCER_SOCK` | `~/.singularity/sockets/pgbouncer-tx.sock` |

Old `PGHOST`/`PGPORT`/`PGUSER` reads removed from `server/src/db/client.ts`. `SINGULARITY_WORKTREE` retained.

### PgBouncer config (catch-all)

```ini
[databases]
* = host=/.../singularity/postgres/socket port=5433

[pgbouncer]
listen_addr =
unix_socket_dir = ~/.singularity/sockets
unix_socket_mode = 0700
pool_mode = transaction
max_client_conn = 200
default_pool_size = 5
auth_type = trust
auth_file = ~/.singularity/postgres/userlist.txt
```

Catch-all `* =` means **no SIGHUP needed** on worktree create/destroy — any DB name routes to the embedded cluster automatically. This eliminates the only reason worktree code would call back to the central plugin.

### Lifecycle

`onReady()` in `supervisor.ts`:
1. Ensure `data-pg18/` exists; if not, run `initdb -D <path> -U singularity --no-locale --encoding UTF8`.
2. If `data-pg18/postmaster.pid` exists, probe `pg_isready`. If alive, skip spawn. If dead, unlink the pidfile.
3. **Auto-migrate from system PG (only on first init):** if `initdb` just ran AND a system PG is reachable on `localhost:5432` AND it has a `singularity` DB, run `migrate-from-system.ts` (see below) before continuing.
4. Spawn `postgres -D <data> -k <socket> -p 5433 -c max_connections=200`, detached, logs piped to `postgres.log`.
5. Poll `pg_isready` with backoff, 30s timeout.
6. Write `pgbouncer.ini` + `userlist.txt` fresh (idempotent).
7. Spawn PgBouncer.
8. Resolve exported `ready` promise.

`onShutdown()`: SIGTERM PgBouncer (5s grace) → `pg_ctl stop -m fast` (10s grace) → SIGKILL survivors.

Watchdog: `setInterval(2s, pg_isready).unref()`. On PG death: log, attempt one re-spawn, then set `crashed: true`. Surface via `GET /api/database/status`. Do NOT auto-restart in a loop (would mask real failures).

### Central plugin ordering

`database` must run `onReady` before `secrets`/`auth` are reachable. Central currently runs `onReady` in topo-sorted order via `central/src/plugins.generated.ts`. Add a `priority` field (or `dependsOn: ["database"]` on auth/secrets) so the database plugin resolves first. Export a `ready` promise that downstream plugins await.

### Auto-migration (first-run only)

`migrate-from-system.ts`, triggered exactly once after a fresh `initdb`:

1. Run `pg_isready -h localhost -p 5432`. If not reachable → skip, no migration needed.
2. Probe `psql -h localhost -lAt`. If no `singularity` DB → skip.
3. Mark migration in progress via `~/.singularity/postgres/.migrating` sentinel file.
4. `pg_dumpall -h localhost --globals-only --no-role-passwords | psql -h <embedded-socket> -p 5433 -d postgres` — migrate roles.
5. For each DB matching `^singularity$|^att-.+`: `pg_dump -Fc -h localhost <db> | pg_restore -h <embedded-socket> -p 5433 -C -d postgres`.
6. Verify `SELECT count(*) FROM __singularity_migrations` on embedded `singularity`.
7. Remove sentinel.
8. Log clear summary line + write `~/.singularity/postgres/migration-completed-at` marker.

Failure handling: if step 4 or 5 errors, leave sentinel in place, log the error, abort `onReady`. The central plugin reports `crashed: true` via status endpoint; the user sees a clear error and can retry by removing the sentinel + the half-populated `data-pg18/` dir. The original system-PG data is untouched (reads only).

### `./equin build` integration

Today `cli/src/commands/build.ts:202-244` calls `waitForDatabase(name)` which shells out to `psql`. Post-migration, `psql` connects via `PGHOST=<socket-dir>` — but **central might not be running yet** when build runs in a fresh terminal (gateway lazy-spawns central only on HTTP request to a central route).

Fix: add `ensureDatabaseReachable()` to `build.ts` BEFORE `waitForDatabase()`:
1. `fetch("http://localhost:9000/api/database/status")` — forces gateway to spawn central, which runs `onReady` (initdb + migrate + spawn PG + spawn PgBouncer).
2. Poll until `{ pg: "running" }` or 60s timeout (90s on first run to absorb initdb + auto-migrate).

`generateMigration()` in `cli/src/migrations.ts` then sets `PGHOST=$SINGULARITY_PG_SOCKET_DIR`, `PGPORT=$SINGULARITY_PG_PORT` on the drizzle-kit subprocess. drizzle-kit honours standard libpq env vars — no drizzle-side change needed.

### `db-fork.ts` changes

`plugins/conversations/server/internal/db-fork.ts:9-47`: update the `pg_dump`/`pg_restore`/`psql` subprocess env to use `SINGULARITY_PG_SOCKET_DIR` for `PGHOST` and `SINGULARITY_PG_PORT`. Same `pg_dump | pg_restore` flow; no logic change. (TEMPLATE fork deferred — see v2.)

### `docs/setup.md` rewrite

Replace `brew install postgresql@18` section. New flow:

```bash
git clone ...
bun install              # postinstall: pulls @embedded-postgres/* + downloads PgBouncer
./equin start      # gateway → central → initdb (first run ~30s, may auto-migrate from system PG)
```

Open `http://singularity.localhost:9000`. Document `SINGULARITY_USE_SYSTEM_PG=1` as escape hatch for users who explicitly want to keep system PG (skips the postinstall + central PG supervision; falls back to existing env-var logic).

## Critical files

- **NEW** `plugins/infra/plugins/database/central/index.ts` — `CentralPluginDefinition` entry point.
- **NEW** `plugins/infra/plugins/database/central/internal/{supervisor,initdb,binaries,paths,pgbouncer-config,migrate-from-system}.ts`
- `central/src/plugins.generated.ts` — auto-regen will pick up new plugin; ordering hook needed (priority/dependsOn).
- `central/src/types.ts` — add `priority?: number` or `dependsOn?: string[]` to `CentralPluginDefinition`.
- `server/src/db/client.ts` — swap `pool` to PgBouncer socket; `adminPool` and `openShortLivedClient` to direct PG socket; remove `PGHOST`/`PGPORT`/`PGUSER` reads.
- `plugins/infra/plugins/jobs/server/internal/worker.ts:29,36` — confirm `connectionString` (from `client.ts`) routes graphile-worker to direct PG, not PgBouncer.
- `plugins/conversations/server/internal/db-fork.ts:9-47` — update subprocess env to new vars.
- `cli/src/commands/build.ts` — add `ensureDatabaseReachable()` before `waitForDatabase()`.
- `cli/src/migrations.ts` — pass new env vars to drizzle-kit subprocess.
- `gateway/worktree.go:357` — inject `SINGULARITY_PG_SOCKET_DIR`, `SINGULARITY_PG_PORT`, `SINGULARITY_PGBOUNCER_SOCK` into worktree backend env.
- `package.json` — add `@embedded-postgres/darwin-arm64`, `@embedded-postgres/darwin-x64`, `@embedded-postgres/linux-x64` as optionalDependencies; add `scripts/install-pgbouncer.ts` postinstall.
- **NEW** `scripts/install-pgbouncer.ts` — fetch PgBouncer binary from pinned GitHub Release per platform, verify SHA, extract to `~/.singularity/binaries/pgbouncer-<version>/`.
- `docs/setup.md` — rewrite first-run flow.

## Reuses

- `central/src/types.ts` `CentralPluginDefinition` (existing pattern).
- `cli/src/utils/bins.ts` `resolveBin()` (binary path resolution helper).
- Existing socket convention `~/.singularity/sockets/` (used by gateway + central).
- `pg_isready` from the bundled PG binaries — same package supplies the client tools.

## Verification

End-to-end smoke (run in this order):

1. **Fresh install path:**
   - `rm -rf ~/.singularity/postgres/` (simulating fresh install).
   - `bun install` — confirm `@embedded-postgres/*` extracted, PgBouncer downloaded.
   - `./equin start` — observe initdb logs, PG spawn, PgBouncer spawn.
   - `psql -h ~/.singularity/postgres/socket -p 5433 -l` — confirm cluster up.
   - `./equin build` — succeeds (migrations apply on fresh embedded `singularity` DB).
   - Open `http://singularity.localhost:9000` — app loads, no PG errors.

2. **Auto-migration path:**
   - Start with system PG running and `singularity` + a few `att-*` DBs populated.
   - `rm -rf ~/.singularity/postgres/`.
   - `./equin start` — observe "Detected system PG, migrating…" log lines.
   - Verify `psql -h ~/.singularity/postgres/socket -p 5433 -l` lists the migrated DBs.
   - Open the app, confirm conversations + tasks load from migrated data.

3. **Connection budget:**
   - With ≥10 worktrees active, run `psql -h ~/.singularity/postgres/socket -p 5433 -d postgres -c "SELECT count(*) FROM pg_stat_activity"`.
   - Expected: well under 100 (PgBouncer multiplexes app pools).
   - Confirm graphile-worker still picks up jobs (start a turn in any worktree → job runs).

4. **Crash recovery:**
   - Find embedded PG PID via `~/.singularity/postgres/data-pg18/postmaster.pid`, `kill -9` it.
   - Wait 5s, hit `GET http://localhost:9000/api/database/status` — should report PG re-spawned (one retry) or `crashed: true`.

5. **Graceful shutdown:**
   - SIGTERM the gateway. Confirm via logs that central calls `onShutdown` → PgBouncer SIGTERM → `pg_ctl stop`. Confirm no leftover `postmaster.pid` after a clean stop.

6. **Existing tests:**
   - `./equin check` passes.
   - All plugin unit/integration tests pass.

## Risks

- **Port 5432 collision** — embedded uses `5433` to coexist with a still-running system PG during migration window. Documented.
- **Auto-migration partial failure** — sentinel file blocks restart; user sees clear error. Original system-PG data untouched.
- **`@embedded-postgres/*` lag on PG version bumps** — accepted tradeoff per user choice. Pin a known-good version; bump deliberately.
- **PgBouncer tx-mode incompatibilities elsewhere in the codebase** — exhaustive audit in this plan covers `LISTEN/NOTIFY`, advisory locks, prepared statements, server-side cursors, `subscribe()`. Only graphile-worker is affected and is explicitly bypassed.
- **Central plugin ordering regression** — adding `priority`/`dependsOn` is a load-bearing change to `central/src/types.ts`. Ship the ordering primitive first, then add the database plugin.

## v2 follow-ups (out of scope)

- Replace `pg_dump | pg_restore` in `db-fork.ts` with `CREATE DATABASE … TEMPLATE singularity` after adding a "terminate connections to template DB" step.
- Bundle `psql` / `pg_dump` directly in `@embedded-postgres/*` resolution so users don't need system PG client tools.
- Add a `./equin migrate-from-embedded` reverse-migration command for users who want to bail out.
