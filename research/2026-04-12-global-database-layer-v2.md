# Database Layer — v2

## Context

equin needs persistent storage for plugin state (first concrete use cases: conversations, todos). The server is currently stateless. Requirements:

1. **Schema defined in TypeScript** — no hand-written SQL or migration files.
2. **Parallel-agent safe** — multiple worktrees can evolve schema independently; merges compose without manual reconciliation.
3. **Worktree-isolated data** — each worktree's server sees a forked copy of main's data so agents can exercise realistic flows without corrupting prod.
4. **Prod-matching semantics** — local dev should behave identically to remote prod.

**Key decisions:**
- **Don't build a new library.** Drizzle ORM already gives us schema-as-TS-object + migration diffing. The novel concern — parallel-agent migration merge — is a thin layer on top, deferred until it actually bites.
- **Use a real PostgreSQL server**, not PGlite. A single local Postgres serves all worktrees via one database per worktree. Forking is a single `CREATE DATABASE <wt> TEMPLATE main_db` — atomic, instant, no app-level coordination. PGlite was considered (zero-setup appeal) but required an app-level `dumpDataDir` dance to fork a live DB consistently. Postgres gives bit-identical prod parity and eliminates that complexity.
- **Schema ownership:** shared in `server/`, but each plugin contributes its own tables via the plugin API. No cross-plugin schema imports; one Drizzle instance, one migrations folder.
- **Don't design real plugin schemas yet.** Stand up the plumbing with a dummy plugin (`plugins/db-smoketest/`) holding a single throwaway table. Real plugin schemas (conversations, todos) get their own design docs later.

## Stack

- **Drizzle ORM** (`drizzle-orm`) — schema definitions, typed queries.
- **Drizzle Kit** (`drizzle-kit`) — `schema.ts` → SQL migration files.
- **PostgreSQL 16** — local via `brew services` or a `docker-compose.yml` the CLI auto-starts. `postgres` driver (`postgres` npm package) from the Bun server.

## Plugin API

Extend `ServerPluginDefinition` with a `schema` field. A plugin contributes a set of Drizzle tables; the server aggregates them.

**`server/src/types.ts`:**
```typescript
import type { PgTable } from "drizzle-orm/pg-core";

export interface ServerPluginDefinition {
  id: string;
  name: string;
  httpRoutes?: Record<string, HttpHandler>;
  wsRoutes?: Record<string, WsHandler>;
  schema?: Record<string, PgTable>;  // NEW — tables this plugin owns
}
```

**Plugin side** (`plugins/db-smoketest/server/schema.ts`):
```typescript
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const smoketest = pgTable("smoketest", {
  id: text("id").primaryKey(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Plugin side** (`plugins/db-smoketest/server/index.ts`):
```typescript
import * as schema from "./schema";
import { handleWrite, handleRead } from "./internal/handlers";

const plugin: ServerPluginDefinition = {
  id: "db-smoketest",
  name: "DB Smoketest",
  schema,                         // re-export the whole module
  httpRoutes: {
    "POST /api/smoketest": handleWrite,
    "GET /api/smoketest":  handleRead,
  },
};
export default plugin;
```

**Server aggregation** (`server/src/db/schema.ts`):
```typescript
import { plugins } from "../plugins";
export const schema = Object.assign({}, ...plugins.map(p => p.schema ?? {}));
```

**Client** (`server/src/db/client.ts`):
```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

const dbName = process.env.SINGULARITY_WORKTREE ?? "main";
const sql = postgres(`postgres://singularity@localhost:5432/${dbName}`);
export const db = drizzle(sql, { schema });
```

**Plugin consumes the client** by importing from `server/src/db/client.ts` inside its handler code.

### Table-name collisions

Two plugins could define a table called `"items"`. Convention: **prefix table names with plugin id** (e.g. `smoketest_items`). Enforce this by validating at boot — the aggregator checks each table's name starts with its owning plugin id, errors loudly if not.

### Drizzle Kit visibility

`drizzle.config.ts` needs a schema entrypoint. Point it at `server/src/db/schema.ts` — Drizzle Kit reads the aggregated module, sees all plugin tables, diffs against the live DB.

## Worktree data forks

- **Postgres server**: runs locally on port 5432. Server checks `pg_isready` at boot; errors clearly if unreachable.
- **One database per worktree**, named after the worktree. `main` worktree → db `main`.
- **Fork point = conversation creation.** Worktree creation lives in `plugins/conversations/server/internal/tmux.ts` → `createConversation()` (which runs `git worktree add` + `tmux new-session`). There is no standalone CLI for worktree create/delete. The fork call slots in there:
  ```sql
  CREATE DATABASE "<name>" TEMPLATE "main";
  ```
  right after the `git worktree add` succeeds. Postgres briefly blocks connections to `main` (milliseconds), takes a storage-level consistent snapshot. No app-level coordination needed.
- **Cleanup:** `deleteConversation()` in the same file runs `DROP DATABASE "<name>";` after killing the tmux session.
- The DB calls live in a small helper (`plugins/conversations/server/internal/db-fork.ts`) that imports the shared `postgres` client from `server/src/db/client.ts` — keeps the tmux module focused.
- Server reads `SINGULARITY_WORKTREE` (set by the gateway) to pick which database to connect to.
- Writes in a worktree stay local to its database. `./equin push` only merges code + migration files.
- On main's server restart after a merge, Drizzle applies any new migrations to the `main` database.

### Prod

"Prod" locally = the `main` database on the dev machine. Remote prod = a managed Postgres with the same schema; swap the connection string, same Drizzle code. The fork-via-TEMPLATE model is dev-only; prod runs a single DB.

## Parallel-agent migrations

- Agents never write migrations by hand. They edit `schema.ts` in their plugin.
- `./equin push` runs `drizzle-kit generate` before pushing. Output: a migration file under `server/src/db/migrations/`.
- **Filename = content-hash**, not timestamp. Two agents independently adding different columns produce different hashes → no filename collision on merge.
- **Additive-only by default.** Adding tables/columns composes trivially. Drops/renames require a CLI opt-in flag; they can't auto-merge.
- **Journal conflict:** Drizzle's `_meta/_journal.json` is a derived file. Regenerate it from the migration set at build time rather than relying on git merge.
- **Schema conflict:** if two agents rename the same column differently, `schema.ts` has a normal git conflict. Resolve like code.
- **Backfills:** start with static defaults only. Add a `backfill: (row) => ...` hook when first needed.

### Scope note

**Implement plain Drizzle + Postgres + worktree forks first.** The content-hash naming, journal regeneration, and backfill hooks are additive — build them the first time two agents actually conflict. Keep this plan's scope to the foundation.

## Files to create

- `server/package.json` — add `drizzle-orm`, `drizzle-kit`, `postgres`.
- `server/src/db/client.ts` — opens Postgres connection per `SINGULARITY_WORKTREE`, exports `db`.
- `server/src/db/schema.ts` — aggregates `plugin.schema` across all plugins.
- `server/src/db/migrate.ts` — runs pending migrations on boot.
- `server/drizzle.config.ts` — dialect `postgresql`, schema at `src/db/schema.ts`, out `src/db/migrations`.
- `server/src/db/migrations/` — generated SQL (committed).
- `plugins/db-smoketest/server/schema.ts` — one dummy table (`smoketest`).
- `plugins/db-smoketest/server/index.ts` — ServerPluginDefinition with `schema`, plus `POST`/`GET /api/smoketest` handlers.
- `plugins/conversations/server/internal/db-fork.ts` — `forkDatabase(name)` / `dropDatabase(name)` helpers that open an admin connection to Postgres and run the DDL.
- `docker-compose.yml` (root) — Postgres 16 service. Alternative: document `brew services start postgresql@16`.

## Files to modify

- `server/src/types.ts` — add optional `schema?: Record<string, PgTable>` to `ServerPluginDefinition`.
- `server/src/index.ts` — call `runMigrations()` before `Bun.serve()`.
- `server/src/plugins.ts` — register `db-smoketest` plugin.
- `plugins/conversations/server/internal/tmux.ts` — `createConversation()` calls `forkDatabase(name)` after `git worktree add`; `deleteConversation()` calls `dropDatabase(name)` after `tmux kill-session`.

## Verification

1. `bun install` at repo root. Drizzle + `postgres` resolve.
2. Start Postgres (compose or brew). `createdb main`.
3. `./equin build` in main. Server boots, migrations run, `smoketest` table exists in `main` db.
4. `POST /api/smoketest` with a note; `GET` returns it.
5. In the UI, create a new conversation (triggers `createConversation` → git worktree + tmux + `CREATE DATABASE TEMPLATE`). Verify `psql -l` shows the `<conversation-name>` database. Hit `GET /api/smoketest` on `http://<conversation>.localhost:9000` — the row from step 4 is present (forked).
6. `POST` a different note in the conversation's server. In main, `GET` — new note is **not** visible (fork is isolated). Delete the conversation — `psql -l` no longer lists the db.
7. In the worktree, add a column to `smoketest` schema. `./equin push`. After main server restarts, column exists in `main` db; old row has the default.
8. Parallel-agent smoke test: two worktrees each add a different column to `smoketest`. Merge both. Both migrations apply to `main`; both columns present.
