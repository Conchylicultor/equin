# Database Layer — Follow-ups

Deferred work from [`2026-04-12-global-database-layer-v2.md`](./2026-04-12-global-database-layer-v2.md) plus gaps surfaced during implementation. Not an ordered roadmap — each item is an independent design problem that can be picked up when the pain shows up.

## Parallel-agent migration merge

The plan's headline feature, deferred because one-agent-at-a-time hasn't hit it yet.

- **Content-hash filenames.** Drizzle's default `NNNN_<word>_<word>.sql` uses a sequential number as the sort key. Two agents each producing `0001_xxx.sql` on different branches produce unmergeable names. Replace with content-hash prefixes so independent migrations never collide.
- **Migration order on merge.** Topological by schema dependency, not filename. Requires reading each migration's DDL, or metadata embedded at generate time.
- **Journal regeneration.** Drizzle's `_meta/_journal.json` is a derived index. Don't rely on git to merge it — regenerate at build time from the migration file set.
- **Additive-only enforcement.** Add a CLI flag (`--allow-destructive`) required for DROP/RENAME DDL. Default refuses, because those don't auto-merge.
- **Backfill hooks.** Today only static defaults work. Add a per-migration `backfill: (row) => ...` TS hook executed between `ADD COLUMN NULL` and `SET NOT NULL`. Needed the first time an agent adds a NOT NULL column with a computed default.

## Runtime / operational gaps

- **Orphaned databases.** `dropDatabase` runs inside `deleteConversation`. If tmux is killed outside the app (`tmux kill-session` manually, machine crash mid-session, worktree removed via `git worktree remove`), the DB stays behind. Need a sweeper: list `pg_database` entries, cross-check against active worktree registry (`~/.singularity/worktrees/*.json`), drop orphans.
- **Pre-existing worktrees.** Any worktree created before the DB code existed has no forked DB. Accessing it now errors on connect. Need either a lazy "fork on first miss" or a one-off backfill command.
- **Connection pool sizing.** `client.ts` sets `max: 10` per process. N running worktrees × 10 = 10N connections against one Postgres server. Postgres default `max_connections=100` caps this at ~10 worktrees. Revisit when concurrent worktrees grow: lower per-process pool, raise Postgres cap, or pool at the gateway.
- **Head DB bootstrap.** `createdb singularity` is a manual setup step. Could be auto-created on first `./equin build` if missing.
- **Gateway env propagation.** Current deployed gateway binary predates the `SINGULARITY_WORKTREE` env. Restart required after gateway rebuild — document or automate.

## Tooling correctness

- **Migrations-in-sync check.** CI / pre-commit should run `drizzle-kit generate --dry-run` (or equivalent) and fail if `schema.ts` diverges from the committed migration set. Prevents "agent edited schema but forgot to build" from reaching main.
- **Bun-free schema enforcement.** `schema.ts` files are loaded by drizzle-kit under Node CJS. Importing anything Bun-specific (e.g. `import.meta.dir`, `Bun.*`) crashes generate. Currently enforced by convention — add a lint rule or a smoke-test that loads every plugin schema under Node.
- **Readable migration names.** Drizzle's random `0000_volatile_orphan.sql` is opaque. Wire `--name` into build or accept a plugin-side convention (e.g. commit message → migration name).

## Plugin API

- **Schema registration is manual.** Adding a plugin with tables requires one line in `server/src/db/schema.ts` (`export * from "../../../plugins/<name>/server/schema"`). Mirrors `server/src/plugins.ts` registration. Could be automated by a glob, but that re-introduces the "drizzle-kit loads everything" problem — the manual list is what keeps the schema module leaf-only.
- **Table-name collisions.** No enforcement today. Two plugins defining `items` would silently shadow. Add a boot-time check: every table name must be prefixed with its owning plugin id (requires knowing the owner — re-introduces plugin-aware aggregation, or embed the prefix convention as a lint).

## Prod story

- **Remote Postgres.** Today everything assumes local Postgres via Unix socket. Remote deploy needs a managed DB + connection-string config. Drizzle and `postgres-js` already support this — just swap the URL. Fork-on-conversation model is dev-only; prod runs a single DB.
- **Backups.** Nothing yet. When real data lands (conversations, todos), define a backup story before it matters.
