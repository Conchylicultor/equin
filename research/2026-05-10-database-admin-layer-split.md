# Database Plugin: Admin Layer Split

## Context

The database plugin (`@plugins/database/server`) currently exports raw Postgres internals (`adminPool`, `pool`, `connectionString`, `libpqSubprocessEnv`, `isTransientPgError`) to all consumers. This caused a real bug: the backup plugin independently derived connection params and dumped the wrong Postgres instance. The fix was ad-hoc; the structural fix is to split the plugin into two layers so 95% of plugins never see PG vocabulary, and the 3 plugins that need admin operations get high-level methods instead of raw pools.

## Design

### Layer 1: `@plugins/database/server` (clean API)

What 50+ feature plugins import. No PG vocabulary.

```ts
export { db } from "./internal/client";          // Drizzle query builder
export { awaitDbReady } from "./internal/client";  // renamed from awaitPgReady
export { isTransientDbError } from "./internal/client"; // renamed from isTransientPgError
export { default } from "./internal/plugin";
```

Removed from barrel: `pool`, `adminPool`, `openShortLivedClient`, `connectionString`, `libpqSubprocessEnv`.

### Layer 2: `@plugins/database/plugins/admin/server` (power-user API)

High-level operations. 5 consumers opt in explicitly.

```ts
// High-level ops — no PG vocabulary
listDatabases(): Promise<string[]>
forkDatabase(source: string, target: string): Promise<void>
dropDatabase(name: string): Promise<void>
databaseExists(name: string): Promise<boolean>
backupDatabase(name: string, outFile: string): Promise<void>
inspectBackup(file: string, name: string): Promise<BackupInfo>

// Internal plumbing (used by database root plugin + query sibling)
setAdminPool(pool: Pool): void
openShortLivedClient(dbName: string): Pool

// Escape hatch (1 consumer: graphile-worker in jobs)
connectionString: string
```

## File changes

### Create (7 files)

**`plugins/database/plugins/admin/server/index.ts`** — barrel:
```ts
export { setAdminPool, openShortLivedClient, connectionString } from "./internal/pool";
export { listDatabases, databaseExists, dropDatabase } from "./internal/databases";
export { forkDatabase } from "./internal/fork";
export { backupDatabase, inspectBackup } from "./internal/backup";
export type { BackupInfo, TableStat } from "./internal/backup";
export { default } from "./internal/plugin";
```

**`plugins/database/plugins/admin/server/internal/plugin.ts`** — minimal plugin def (id `database-admin`, no onReady, no routes).

**`plugins/database/plugins/admin/server/internal/pool.ts`** — move from `client.ts`:
- `setAdminPool(pool)` / `getAdminPool()` — moved from `embedded/cluster.ts`
- `openShortLivedClient(dbName)` — moved from `client.ts`
- `connectionString` — moved from `client.ts`
- `libpqSubprocessEnv` — moved from `client.ts` (NOT exported from barrel — internal only, used by fork.ts/backup.ts)
- All derive connection config from `readDatabaseConfig()` + `process.env.PG*` (same as client.ts)

**`plugins/database/plugins/admin/server/internal/databases.ts`** — consolidated from `embedded/cluster.ts` + `db-fork.ts`:
- `listDatabases()` — returns all non-template DB names (no filtering — callers filter)
- `databaseExists(name)` — point check via `pg_database`
- `dropDatabase(name)` — `DROP DATABASE IF EXISTS ... WITH (FORCE)`
- Shared `assertSafeName()` helper

**`plugins/database/plugins/admin/server/internal/fork.ts`** — moved from `conversations/server/internal/db-fork.ts`:
- `forkDatabase(source, target)` — CREATE DATABASE + pg_dump|pg_restore + drop graphile_worker schema
- Uses `getAdminPool()`, `libpqSubprocessEnv`, `openShortLivedClient` from `./pool`
- Uses `dropDatabase` from `./databases` for cleanup on failure

**`plugins/database/plugins/admin/server/internal/backup.ts`** — extracted from `db-backup/handle-backup.ts` + `list-backups.ts`:
- `backupDatabase(name, outFile)` — spawns `pg_dump -Fc` with `libpqSubprocessEnv`
- `inspectBackup(file, name)` — runs `pg_restore --list` + `pg_restore --data-only` to extract table names and row counts; also `stat()` for size
- Types: `TableStat`, `BackupInfo`

**`plugins/database/plugins/admin/package.json`** — workspace package `@singularity/plugin-database-admin`.

### Delete (2 files)

- `plugins/conversations/server/internal/db-fork.ts` — logic moves to `admin/fork.ts`
- `plugins/database/plugins/embedded/server/internal/cluster.ts` — logic moves to `admin/databases.ts` + `admin/pool.ts`

### Modify

**`plugins/database/server/internal/client.ts`**:
- Remove exports: `connectionString`, `openShortLivedClient`, `libpqSubprocessEnv`, `adminPool`
- Keep `pool` as unexported module-local (still needed by `db = drizzle(pool)` and `awaitReady`)
- Keep `adminPool` as unexported module-local (still needed by `plugin.ts` sibling via direct import)
- Rename: `awaitPgReady` → `awaitReady`, `isTransientPgError` → `isTransientDbError`

**`plugins/database/server/index.ts`** — strip to `db`, `awaitReady`, `isTransientDbError`, default plugin.

**`plugins/database/server/internal/plugin.ts`**:
- `setAdminPool` import: `@plugins/database/plugins/embedded/server` → `@plugins/database/plugins/admin/server`
- `awaitPgReady()` → `awaitReady()`
- `adminPool` import stays as a sibling internal import from `./client`

**`plugins/database/plugins/embedded/server/index.ts`** — remove `dropDatabase`, `databaseExists`, `setAdminPool` re-exports. Keep path constant re-exports + default plugin.

### Consumer migrations

| File | Before | After |
|---|---|---|
| `conversations/server/internal/lifecycle.ts` | `import { forkDatabase } from "./db-fork"` | `import { forkDatabase } from "@plugins/database/plugins/admin/server"` + flip args to `(source, target)` |
| `conversations/server/internal/poller.ts` | `import { isTransientPgError }` | `import { isTransientDbError }` (same path) |
| `conversations/server/internal/turn-emitter.ts` | `import { db, isTransientPgError }` | `import { db, isTransientDbError }` (same path) |
| `conversations/server/index.ts` | re-exports from `db-fork` (if any) | remove |
| `debug/db-backup/handle-backup.ts` | `import { adminPool, libpqSubprocessEnv }` + inline pg_dump | `import { listDatabases, backupDatabase } from admin` |
| `debug/db-backup/list-backups.ts` | inline `getTableNames`/`getRowCounts`/`getDumpStats` | `import { inspectBackup } from admin` |
| `debug/worktree-cleanup/handle-delete.ts` | `from "@plugins/database/plugins/embedded/server"` | `from "@plugins/database/plugins/admin/server"` |
| `debug/worktree-cleanup/handle-bulk-delete.ts` | same | same |
| `debug/worktree-cleanup/handle-list.ts` | `databaseExists` from embedded | from admin |
| `infra/jobs/worker.ts` | `import { connectionString, db } from database` | split: `db` from database, `connectionString` from admin |
| `database/query/mcp-tools.ts` | `openShortLivedClient` from database + `databaseExists` from embedded | both from admin |

### Files NOT changed

All 50 files that only import `db` from `@plugins/database/server` — zero changes needed.

## Verification

1. `./equin build` — must succeed (auto-regenerates plugin registry, runs migration check)
2. `./equin check` — all checks pass (plugin boundaries, eslint, migrations-in-sync)
3. Trigger a backup from the UI → verify it dumps the embedded PG (check file size matches previous correct backup ~1MB, not the stale 723KB)
4. Launch a conversation → verify DB fork succeeds (conversation starts, worktree DB created)
5. Worktree cleanup → verify drop works
