# Migrate database infrastructure to `plugins/database/`

## Context

Database infrastructure is scattered across four locations:
- `server/src/db/` — connection pool, migration runner, types, migration files
- `server/drizzle.config.ts` — schema discovery and migration generation config
- `server/src/embedded-pg-defaults.ts` — mirrored PG constants (breaks circular dep)
- `plugins/infra/plugins/database/` — embedded PG binaries, shared constants, DDL helpers
- `plugins/database/plugins/query/` — `query_db` MCP tool (already in place)

This consolidates everything under `plugins/database/` so the database is a self-contained, load-bearing plugin owning the full DDL lifecycle.

## Final plugin tree

```
plugins/database/
├── CLAUDE.md
├── package.json
├── server/
│   ├── index.ts                # barrel: db, pool, adminPool, ... + default export
│   └── internal/
│       ├── client.ts           ← from server/src/db/client.ts
│       └── plugin.ts           # ServerPluginDefinition (onReady: awaitPgReady + runMigrations)
├── plugins/
│   ├── embedded/               ← from plugins/infra/plugins/database/
│   │   ├── CLAUDE.md
│   │   ├── package.json        # @embedded-postgres/* optionalDeps
│   │   ├── server/
│   │   │   ├── index.ts
│   │   │   └── internal/
│   │   │       ├── cluster.ts
│   │   │       └── plugin.ts
│   │   └── shared/
│   │       ├── index.ts
│   │       └── internal/
│   │           └── paths.ts
│   ├── migrations/             # DDL lifecycle: drizzle config, runner, SQL files
│   │   ├── drizzle.config.ts   ← from server/drizzle.config.ts
│   │   ├── data/               ← from server/src/db/migrations/ (77 SQL + meta/)
│   │   └── server/
│   │       ├── index.ts        # barrel: runMigrations
│   │       └── internal/
│   │           └── runner.ts   ← from server/src/db/migrate.ts
│   └── query/                  # unchanged structurally
│       └── server/
│           ├── index.ts
│           └── internal/
│               └── mcp-tools.ts
```

## Implementation

### Phase 1 — Create new plugin structure

**1. `plugins/database/server/internal/client.ts`** — Copy from `server/src/db/client.ts`.
- Change import: `from "../embedded-pg-defaults"` → `from "@plugins/database/plugins/embedded/shared"`
- Rename constants: `EMBEDDED_PG_SOCKET_DIR` → `PG_SOCKET_DIR`, `EMBEDDED_PG_USER` → `PG_USER`
- Handle type mismatch: `PG_PORT` is `number` in shared (was `string` in embedded-pg-defaults). Use `String(PG_PORT)` in the two string contexts (URL construction L36, `libpqSubprocessEnv` L74).

**2. `plugins/database/plugins/migrations/server/internal/runner.ts`** — Copy from `server/src/db/migrate.ts`.
- Change `db` import: `from "./client"` → `from "@plugins/database/server"`
- Change migration dir: `join(import.meta.dir, "migrations")` → `join(import.meta.dir, "..", "..", "data")` (from `server/internal/` up to `plugins/database/plugins/migrations/data/`)

**3. `plugins/database/plugins/migrations/server/index.ts`** — New barrel:
```typescript
export { runMigrations } from "./internal/runner";
export { default } from "./internal/plugin";
```

**4. `plugins/database/plugins/migrations/server/internal/plugin.ts`** — New file:
```typescript
import type { ServerPluginDefinition } from "@server/types";

const plugin: ServerPluginDefinition = {
  id: "database-migrations",
  name: "Database Migrations",
  description: "DDL lifecycle: migration runner and SQL files.",
};
export default plugin;
```

**5. `plugins/database/server/internal/plugin.ts`** — New file:
```typescript
import type { ServerPluginDefinition } from "@server/types";
import { awaitPgReady } from "./client";
import { runMigrations } from "@plugins/database/plugins/migrations/server";

const plugin: ServerPluginDefinition = {
  id: "database",
  name: "Database",
  description: "Core database infrastructure. Connection pooling and PG readiness.",
  loadBearing: true,
  async onReady() {
    await awaitPgReady();
    await runMigrations();
  },
};
export default plugin;
```

**6. `plugins/database/server/index.ts`** — New barrel:
```typescript
export {
  db, pool, adminPool, openShortLivedClient, connectionString,
  libpqSubprocessEnv, isTransientPgError, awaitPgReady,
} from "./internal/client";
export { default } from "./internal/plugin";
```

**7. Move migrations data** — `git mv server/src/db/migrations plugins/database/plugins/migrations/data`

**8. Move + adapt drizzle config** — `git mv server/drizzle.config.ts plugins/database/plugins/migrations/drizzle.config.ts`
- `out`: `"./src/db/migrations"` → `"./data"`
- Schema globs: `"../plugins/**/..."` → `"../../../../plugins/**/..."` (from `plugins/database/plugins/migrations/`, four levels up to repo root, then into `plugins/`)
- Comment referencing `plugins/infra/plugins/database/` → `plugins/database/plugins/embedded/`
- `dbCredentials.url` construction is env-var based, no path change needed

**9. Move embedded plugin** — `git mv plugins/infra/plugins/database plugins/database/plugins/embedded`
- `server/internal/plugin.ts`: id `"database"` → `"database-embedded"`
- `server/internal/cluster.ts`: `import { adminPool } from "@server/db/client"` → `from "@plugins/database/server"`
- `server/index.ts`: self-import `from "@plugins/infra/plugins/database/shared"` → `from "@plugins/database/plugins/embedded/shared"`
- `package.json`: name `"@singularity/plugin-infra-database"` → `"@singularity/plugin-database-embedded"`

**10. Move `rankText` to rank primitive** — Create `plugins/primitives/plugins/rank/server/internal/types.ts` with the `rankText` definition from `server/src/db/types.ts`. Update `plugins/primitives/plugins/rank/server/index.ts`:
- `export { rankText } from "@server/db/types"` → `export { rankText } from "./internal/types"`

### Phase 2 — Bulk import updates

**9. `@server/db/client` → `@plugins/database/server`** (~87 files)

Mechanical find-and-replace across all plugin server code. Exported names are identical.

**10. `@server/db/types` → `@plugins/primitives/plugins/rank/server`** (7 files)

These 7 `tables.ts` files import `{ rankText }`:
- `plugins/reorder/server/internal/tables.ts`
- `plugins/tasks-core/server/internal/tables.ts`
- `plugins/agents/server/internal/tables.ts`
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/tables.ts`
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/tables.ts`
- `plugins/conversations/plugins/conversations-view/plugins/grouped/server/internal/tables.ts`
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/tables.ts`

**11. `@plugins/infra/plugins/database/{server,shared}` consumers** (4 files)
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-bulk-delete.ts` → `@plugins/database/plugins/embedded/server`
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-delete.ts` → same
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-list.ts` → same
- `plugins/database/plugins/query/server/internal/mcp-tools.ts` → same (for `databaseExists`)

### Phase 3 — CLI and tooling

All paths below use `migrationsPlugin = "plugins/database/plugins/migrations"`.

**12. `cli/src/migrations.ts`** — Refactor `serverDir` → `root` parameter.

`generateMigration` signature: replace `serverDir: string` with `root: string`. Internally:
- L40: `resolve(serverDir, "src/db/migrations")` → `resolve(root, migrationsPlugin, "data")`
- L53-58: drizzle-kit `cwd: serverDir` → `cwd: resolve(root, migrationsPlugin)`
- `resetBranchLocalMigrations`: same `serverDir` → `root` refactor
- `resolveRef` / `listTrackedMigrationBasenames`: `cwd: serverDir` → `cwd: root`
- L228: git ls-tree path `"src/db/migrations"` → `"plugins/database/plugins/migrations/data"`

**13. `cli/src/commands/build.ts`** — Update `generateMigration` call:
- `serverDir: resolve(root, "server")` → `root` (already in scope)

**14. `cli/src/commands/regen-migrations.ts`** — Update to pass `root`:
- L29 `assertNoHandEditedBranchLocalMigrations(serverDir)` → pass `root`
- L83 `generateMigration({ serverDir, ... })` → `generateMigration({ root, ... })`

**15. `cli/src/checks/migrations-in-sync.ts`** — Update all paths:
- L26: `resolve(serverDir, "src/db/migrations")` → `resolve(root, migrationsPlugin, "data")`
- L33: `mkdtempSync(join(serverDir, ".check-"))` → `mkdtempSync(join(resolve(root, migrationsPlugin), ".check-"))` (drizzle-kit needs node_modules access from cwd)
- L39: `resolve(serverDir, "drizzle.config.ts")` → `resolve(root, migrationsPlugin, "drizzle.config.ts")`
- L55: config path relative from new cwd
- L58: `cwd: serverDir` → `cwd: resolve(root, migrationsPlugin)`

**16. `cli/src/checks/snapshot-chain-intact.ts`** — L36:
- `resolve(root, "server/src/db/migrations/meta")` → `resolve(root, migrationsPlugin, "data/meta")`

**17. `cli/src/guards/guards/migrations.ts`** — L15:
- `a.includes("db/migrations/")` → `a.includes("migrations/data/")`

**18. `.gitattributes`** — Replace migration paths:
```
plugins/database/plugins/migrations/data/*.sql                merge=regen-migrations
plugins/database/plugins/migrations/data/meta/_journal.json   merge=regen-migrations
plugins/database/plugins/migrations/data/meta/*_snapshot.json merge=regen-migrations
```

**19. `cli/src/paths.ts`** — Update comment referencing `server/src/db/client.ts`

### Phase 4 — Server bootstrap

**20. `server/src/index.ts`** — Remove:
- L3: `import { awaitPgReady } from "./db/client"`
- L4: `import { runMigrations } from "./db/migrate"`
- L26-27: `await awaitPgReady(); await runMigrations();`

**Sequencing note:** Currently migrations run *before* socket binding (L26-27 precede L115 `Bun.serve`). Moving to `onReady` means they run *after* socket binding (L157+). The gateway may start proxying requests before migrations complete. This is an accepted tradeoff — the dependency-ordered plugin loading (separate task) will handle proper sequencing.

### Phase 5 — Delete old files

After all imports are updated:
- `server/src/db/` — entire directory (client.ts, migrate.ts, types.ts already moved; migrations already `git mv`'d)
- `server/src/embedded-pg-defaults.ts`
- `server/drizzle.config.ts` (already `git mv`'d)
- `plugins/infra/plugins/database/` (already `git mv`'d)

### Phase 6 — Documentation

- `server/CLAUDE.md` — Update Database section: new import path `@plugins/database/server`, new migration location, new drizzle config location
- `plugins/database/CLAUDE.md` — Rewrite as the comprehensive database plugin doc
- `plugins/database/plugins/embedded/CLAUDE.md` — Adapt from current `plugins/infra/plugins/database/CLAUDE.md`
- Root `CLAUDE.md` — Update any `server/src/db/` references
- `gateway/postgres.go` — Update comment mentioning `embedded-pg-defaults.ts`

## Verification

1. `rg "@server/db/" plugins/ server/` → zero results
2. `rg "@plugins/infra/plugins/database" .` → zero results  
3. `ls server/src/db/` → not found
4. `ls plugins/database/plugins/migrations/data/*.sql | wc -l` → same count as before
5. `./equin build` → no new migrations generated, server starts, app loads
6. `./equin check` → all checks pass (migrations-in-sync, snapshot-chain-intact, plugin-boundaries, eslint)
7. App loads at `http://<worktree>.localhost:9000`

## Risks

- **PG_PORT type change** (number vs string): Must use `String(PG_PORT)` in client.ts URL/env contexts
- **`import.meta.dir` in runner.ts**: Path `join(import.meta.dir, "..", "..", "data")` must resolve correctly from `plugins/database/plugins/migrations/server/internal/` — verify at runtime
- **Startup sequencing**: Server socket binds before migrations complete after this change. Accepted tradeoff per user decision; dependency-ordered loading is a separate task
- **drizzle-kit cwd change**: The migrations-in-sync check creates a temp dir and runs drizzle-kit. Must ensure temp dir is inside a directory with node_modules access (use `plugins/database/plugins/migrations/` as temp dir root)
- **drizzle.config.ts schema globs**: From `plugins/database/plugins/migrations/`, the path to the repo root is `../../../../`. Schema globs become `"../../../../plugins/**/server/**/internal/tables.ts"` etc. Verify drizzle-kit resolves these correctly.
