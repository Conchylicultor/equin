# PgBouncer Integration

## Context

Each worktree backend opens ~7 PG connections (app pool max 5, admin pool 1, graphile-worker LISTEN connections). With 15–20 active worktrees against `max_connections=500`, connection budget becomes a concern. PgBouncer in transaction mode multiplexes app query connections, reclaiming the budget.

The `@equin/pgbouncer-*` npm packages (v1.25.7) are already published — statically-linked PgBouncer binaries for 4 platforms, same pattern as `@embedded-postgres/*`. This plan wires them into the existing embedded database infrastructure.

## Architecture

### Connection routing (after)

| Caller | Path | Why |
|---|---|---|
| `pool` (Drizzle app queries) in `client.ts` | **PgBouncer socket** (port 6432) | Most traffic; tx pooling reclaims connection budget |
| `adminPool` (CREATE/DROP DATABASE) in `pool.ts` | Direct PG socket (port 5433) | DDL on `postgres` DB, max:1 |
| graphile-worker (`connectionString`) in `worker.ts` | Direct PG socket (port 5433) | LISTEN/NOTIFY + advisory locks — incompatible with tx pooling |
| `fork.ts` (pg_dump/pg_restore subprocesses) | Direct PG socket (port 5433) | Subprocesses; tx pooling adds nothing |
| drizzle-kit migration generation | Direct PG socket (port 5433) | One-shot subprocess |

Only `client.ts`'s pool changes destination. Everything in `admin/pool.ts` stays on direct PG.

### Socket layout

Both sockets live in `~/.singularity/postgres/socket/`:
- `.s.PGSQL.5433` — PG (existing)
- `.s.PGSQL.6432` — PgBouncer (new)

Same host path, different port. `buildConnectionString()` already handles Unix socket dirs — no changes needed to the URL builder.

### PgBouncer config (catch-all)

```ini
[databases]
* = host=<PG_SOCKET_DIR> port=5433

[pgbouncer]
listen_addr =
unix_socket_dir = <PG_SOCKET_DIR>
listen_port = 6432
pool_mode = transaction
max_client_conn = 200
default_pool_size = 5
auth_type = trust
auth_file = <PG_DIR>/userlist.txt
logfile = <PG_DIR>/pgbouncer.log
pidfile = <PG_DIR>/pgbouncer.pid
```

Catch-all `* =` means no SIGHUP on worktree create/destroy — any DB name routes to the cluster automatically.

### Gateway supervisor ordering

PgBouncer becomes the second entry in `database.json`'s `services` array. The supervisor's `StartAll()` iterates sequentially — PG (index 0) is fully ready before PgBouncer (index 1) starts.

## Implementation

### Step 1 — New plugin: `plugins/database/plugins/pgbouncer/`

**`package.json`**
```json
{
  "name": "@singularity/plugin-database-pgbouncer",
  "description": "PgBouncer connection pooler for the embedded Postgres cluster.",
  "private": true,
  "version": "0.0.1",
  "optionalDependencies": {
    "@equin/pgbouncer-darwin-arm64": "1.25.7",
    "@equin/pgbouncer-darwin-x64": "1.25.7",
    "@equin/pgbouncer-linux-x64": "1.25.7",
    "@equin/pgbouncer-linux-arm64": "1.25.7"
  }
}
```

**`shared/internal/paths.ts`** — Pure constants (mirrors `embedded/shared/internal/paths.ts` pattern):
- `PGBOUNCER_PORT = 6432`
- `PGBOUNCER_SOCKET_DIR = join(PG_DIR, "socket")` — same dir as PG
- `PGBOUNCER_CONFIG_FILE = join(PG_DIR, "pgbouncer.ini")`
- `PGBOUNCER_USERLIST_FILE = join(PG_DIR, "userlist.txt")`
- `PGBOUNCER_LOG_FILE = join(PG_DIR, "pgbouncer.log")`
- `PGBOUNCER_PID_FILE = join(PG_DIR, "pgbouncer.pid")`

**`shared/index.ts`** — Barrel re-export of all constants.

**`scripts/start.ts`** — Gateway-supervised lifecycle script. Mirrors `embedded/scripts/start.ts`:
1. Platform binary resolution: `@equin/pgbouncer-<platform>/native/bin/pgbouncer` from plugin's own `node_modules/`
2. Reattach: if pid file exists and socket responds → exit 0
3. Stale pidfile cleanup: if pid file exists but socket dead → remove pid file
4. Generate `pgbouncer.ini` fresh (using PG constants from `@plugins/database/plugins/embedded/shared`)
5. Generate `userlist.txt`: `"singularity" ""` (trust auth, but file must exist)
6. Spawn: `spawnSync(binary, [configFile, "-d"])` — `-d` daemonizes, exits 0 when ready
7. Readiness poll: dial socket up to 30s timeout

**`server/index.ts`** — Server barrel. Default-exports `ServerPluginDefinition`, re-exports path constants.

### Step 2 — Extend `DatabaseConfig` type

**`plugins/database/core/internal/config.ts`**

Add optional `pgbouncer` block to the `DatabaseConfig` interface:
```typescript
pgbouncer?: {
  host: string;   // socket dir (same as connection.host for embedded)
  port: number;   // 6432
};
```

No changes to `readDatabaseConfig()` or `buildConnectionString()` — the new field is simply read from JSON when present and ignored when absent.

### Step 3 — Route app pool through PgBouncer

**`plugins/database/server/internal/client.ts`**

Change the `conn` construction to prefer `config.pgbouncer` when available:

```typescript
const config = readDatabaseConfig();
const conn = config.pgbouncer
  ? { host: config.pgbouncer.host, port: config.pgbouncer.port, user: config.connection.user }
  : { host: process.env.PGHOST ?? config.connection.host,
      port: Number(process.env.PGPORT ?? config.connection.port),
      user: process.env.PGUSER ?? config.connection.user };
```

When `pgbouncer` is present, the pool connects to `~/.singularity/postgres/socket` on port 6432 (PgBouncer). When absent (system PG or no PgBouncer installed), behavior is identical to today.

`PGHOST`/`PGPORT` env overrides are intentionally skipped when PgBouncer is configured — those are for admin tooling (`pg_dump` etc.) and should not redirect the pooled connection.

`awaitDbReady()` and `isTransientDbError()` are unchanged — they already handle `ENOENT`/`ECONNREFUSED` which PgBouncer can also emit during startup.

### Step 4 — Generate PgBouncer entry in `database.json`

**`plugins/framework/plugins/cli/bin/commands/start.ts`** — `ensureDatabaseConfig()`

When embedded PG is detected, also check for PgBouncer package presence:
```typescript
const hasPgBouncer = hasEmbedded && existsSync(
  join(repoRoot, "plugins/database/plugins/pgbouncer/node_modules/@equin"),
);
```

If both are present, the generated config gains:
- `"pgbouncer": { "host": "<socket_dir>", "port": 6432 }` top-level block
- Second service entry at index 1:
  ```json
  {
    "name": "pgbouncer",
    "start": ["bun", "run", "<repoRoot>/plugins/database/plugins/pgbouncer/scripts/start.ts"],
    "ready": { "unix": "<socket_dir>/.s.PGSQL.6432" },
    "watchdog": { "intervalSec": 2 }
  }
  ```

**Upgrade path**: `ensureDatabaseConfig` currently early-returns if `database.json` exists. For existing installs to pick up PgBouncer, add a migration check: if file exists but lacks a `pgbouncer` service entry and `hasPgBouncer` is true, read the existing config, augment it with the pgbouncer block + service, and rewrite.

### Step 5 — Update CLAUDE.md files

- `plugins/database/plugins/embedded/CLAUDE.md` — Remove "No PgBouncer (yet)" note, replace with pointer to sibling `pgbouncer` plugin.
- `plugins/database/CLAUDE.md` — Add `pgbouncer` to sub-plugins list.
- `plugins/database/plugins/pgbouncer/CLAUDE.md` — Create with plugin docs (auto-regenerated by build).

## Critical files

| Action | File |
|---|---|
| **Create** | `plugins/database/plugins/pgbouncer/package.json` |
| **Create** | `plugins/database/plugins/pgbouncer/shared/internal/paths.ts` |
| **Create** | `plugins/database/plugins/pgbouncer/shared/index.ts` |
| **Create** | `plugins/database/plugins/pgbouncer/scripts/start.ts` |
| **Create** | `plugins/database/plugins/pgbouncer/server/index.ts` |
| **Create** | `plugins/database/plugins/pgbouncer/CLAUDE.md` |
| **Modify** | `plugins/database/core/internal/config.ts` — add `pgbouncer?` to `DatabaseConfig` |
| **Modify** | `plugins/database/server/internal/client.ts` — route pool through PgBouncer |
| **Modify** | `plugins/framework/plugins/cli/bin/commands/start.ts` — generate pgbouncer service entry |
| **Modify** | `plugins/database/plugins/embedded/CLAUDE.md` — remove "no pgbouncer" note |
| **Modify** | `plugins/database/CLAUDE.md` — add pgbouncer sub-plugin |

## Reuses

- `embedded/scripts/start.ts` pattern — binary resolution, reattach, socket probe, spawn
- `embedded/shared/internal/paths.ts` pattern — pure constants, `SINGULARITY_DIR` duplication
- Gateway supervisor `services[]` — sequential start, Unix socket ready probe, watchdog
- `readDatabaseConfig()` + `buildConnectionString()` — unchanged, works for PgBouncer socket as-is
- `ensureDatabaseConfig()` — extended, same structure

## Verification

1. `bun install` — confirm `node_modules/@equin/pgbouncer-darwin-arm64/native/bin/pgbouncer` exists under the pgbouncer plugin
2. Delete `~/.singularity/database.json`, run `./equin start` — confirm generated config has both postgres and pgbouncer services + the `pgbouncer` block
3. Check gateway logs: postgres ready first, then pgbouncer ready
4. `ls ~/.singularity/postgres/socket/` — both `.s.PGSQL.5433` and `.s.PGSQL.6432` present
5. `cat ~/.singularity/postgres/pgbouncer.ini` — catch-all config with correct paths
6. Open `http://singularity.localhost:9000` — app loads, no PG errors
7. Create a conversation (triggers db-fork) — fork succeeds (uses direct PG)
8. `./equin build` — succeeds (drizzle-kit uses direct PG for migrations)
9. With 5+ worktrees active: `psql -h ~/.singularity/postgres/socket -p 5433 -d postgres -c "SELECT count(*) FROM pg_stat_activity"` — connection count lower than pre-PgBouncer (PgBouncer multiplexes the 5-max pools)

## Risks

- **tx-mode incompatibility audit**: Only graphile-worker uses LISTEN/NOTIFY and advisory locks — it already routes through `admin/pool.ts` (direct PG), not `client.ts`. Drizzle's node-postgres driver uses simple queries — no prepared statements or server-side cursors. Clean.
- **Existing installs**: Users with an existing `database.json` need the upgrade path (step 4) to pick up PgBouncer. The migration logic reads, augments, and rewrites the file.
- **PgBouncer crash**: The gateway watchdog re-probes every 2s and attempts one restart. If PgBouncer dies and doesn't restart, app pools get `ECONNREFUSED` — `isTransientDbError` already handles this.
