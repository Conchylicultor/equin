# Database Layer

## Context

Singularity needs persistent storage for conversation status, metadata, and todos. Today the server is stateless (Bun + plugin routes, no DB). We want:

1. **Schema defined in TypeScript** — no hand-written SQL, no hand-written migration files.
2. **Parallel-agent safe** — multiple agents working in different worktrees can each evolve the schema. When they merge back to main, migrations compose without manual reconciliation.
3. **Worktree-isolated data** — each worktree's server process gets a forked copy of main's data so agents can exercise realistic flows without corrupting prod.
4. **Postgres-compatible** — local dev shouldn't require running a Postgres service; remote prod can swap to real Postgres later with no schema changes.

**Key decision: don't build a new library.** Drizzle ORM already provides the schema-as-TS-object + migration-diff workflow. The novel piece — parallel-agent migration merging + worktree data forks — is a thin layer on top, not a new ORM.

## Approach

### Stack

- **Drizzle ORM** (`drizzle-orm`) — schema-as-TS-object, strongly typed queries.
- **Drizzle Kit** (`drizzle-kit`) — diffs `schema.ts` against current DB state, generates SQL migration files.
- **PGlite** (`@electric-sql/pglite`) — embedded Postgres (WASM, in-process). Stores state in a directory. Real Postgres semantics; prod can swap to `node-postgres` driver with the same schema.

### Schema ownership

- Shared in `server/`. One connection, one `schema.ts` that re-exports per-plugin schema modules.
- Plugins define their tables in `plugins/<name>/server/schema.ts` and export them.
- `server/src/db/schema.ts` aggregates: `export * from "@plugins/todos/server/schema"; ...`
- Plugins import the shared `db` client from `server/src/db/client.ts`.

### Worktree data forks

- Data dir lives **outside the worktree** at `~/.singularity/data/<worktree-name>/pgdata` (not in git; survives worktree churn).
- `main` worktree's dir is the source of truth ("prod" locally).
- On worktree creation (CLI hook in `cli/`), run `cp -c -R ~/.singularity/data/main/pgdata ~/.singularity/data/<worktree>/pgdata` — APFS clonefile, near-instant, copy-on-write.
- Server reads `SINGULARITY_WORKTREE` env to pick its data dir. Gateway/CLI already know the worktree name.
- Changes in a worktree stay local. `./equin push` only merges code + migration files; data stays in the fork.
- When main's server restarts after a merge, Drizzle applies any new migrations to main's pgdata.

### Parallel-agent migrations

- Agents never write migrations by hand. They edit `schema.ts`.
- At `./equin push` time, CLI runs `drizzle-kit generate` against the worktree's current DB. Output: a migration file under `server/src/db/migrations/`.
- **Filename: content-hash, not timestamp.** Two agents independently adding different columns produce different hashes → no filename collision on merge.
- **Additive-only by convention.** `add table`, `add column` (nullable or with default) compose trivially. Drops/renames require an explicit opt-in flag on the CLI — they can't safely auto-merge and surface as code-review concerns.
- Migration ordering on main: topological by schema dependency, not filename. Drizzle's journal (`_meta/_journal.json`) gets regenerated from the migration set at build time rather than merged — this is the conflict point, but it's a derived file.
- **Conflict model:** if two agents rename the same column differently, `schema.ts` itself has a git conflict. Resolve like any code conflict. The migration generation re-runs after resolution.
- **Backfills:** when adding a non-null column without a default, the agent supplies a backfill function in the same commit. The migration runner executes it between the `ADD COLUMN NULL` and `ALTER ... SET NOT NULL` steps. Start simple: only support static defaults; add backfill hooks when first needed.

### First tables

Two plugins, minimal schema, to prove the end-to-end flow:

- `plugins/conversations/server/schema.ts` — `conversations(id, worktree, status, created_at, updated_at, metadata jsonb)`.
- `plugins/todos/server/schema.ts` — `todos(id, conversation_id fk, text, status, created_at, updated_at)`.

### Do we need the custom layer *now*?

**No.** Ship plain Drizzle + PGlite + worktree forks first. The parallel-migration merge tooling (content-hash names, journal regeneration, backfill hooks) is additive and only matters once two agents actually conflict. Build that the first time it bites. Keep this plan's scope to the foundation.

## Files to create

- `server/package.json` — add `drizzle-orm`, `drizzle-kit`, `@electric-sql/pglite`.
- `server/src/db/client.ts` — opens PGlite against `~/.singularity/data/<worktree>/pgdata`, exports `db`.
- `server/src/db/schema.ts` — re-exports per-plugin schemas.
- `server/src/db/migrate.ts` — runs pending migrations on boot.
- `server/drizzle.config.ts` — Drizzle Kit config (dialect: postgresql, schema path, out path).
- `server/src/db/migrations/` — generated SQL migrations (committed).
- `plugins/conversations/server/schema.ts`, `plugins/todos/server/schema.ts` — first real tables.
- `cli/src/commands/` — extend worktree-creation path to `cp -c -R` the main pgdata dir. See existing CLI entry (check `cli/src/` for the worktree-create command).

## Files to modify

- `server/src/index.ts` — call `runMigrations()` before `Bun.serve()`.
- `server/src/plugins.ts` — nothing structural; plugins wire themselves via their existing `ServerPluginDefinition`.
- `.gitignore` — confirm `~/.singularity/data/` doesn't apply; data lives outside the repo so no ignore needed.

## Verification

1. `bun install` at repo root — Drizzle + PGlite resolve.
2. In main worktree: `./equin build`. Server boots, creates `~/.singularity/data/main/pgdata`, runs initial migration, tables exist.
3. Hit a test endpoint that inserts a todo; confirm via a read endpoint.
4. Create a new worktree via the CLI. Confirm `~/.singularity/data/<new>/pgdata` appears as a clone of main's (APFS clonefile; `ls -l` shows same size, near-instant).
5. In the new worktree: read the todo inserted in step 3 — should be visible (fork inherited data). Insert a new todo in the worktree; confirm it is **not** visible in main's server (check via `http://localhost:9000` vs `http://<worktree>.localhost:9000`).
6. In the worktree, add a column to the todos schema, run `drizzle-kit generate`, commit, `./equin push`. After main restarts, column exists in main's DB; old rows have the default.
7. Parallel-agent smoke test: two worktrees each add a different column to todos. Merge both. Main applies both migrations; both columns present.
