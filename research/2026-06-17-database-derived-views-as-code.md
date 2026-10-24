# Derived views as code, not state

## Context

Interdependent DB views can't be changed in one drizzle migration. `drizzle-kit`
emits view `DROP` statements in snapshot/alphabetical order with no
dependency-aware sort, so when two interdependent views change together it tries
to drop a dependency before its dependent and Postgres refuses (`cannot drop view
X because other objects depend on it`). The generated SQL can't be hand-fixed
either: the runner keys applied-state on the filename `sha8` (which must equal the
content hash) and the push-time hand-edit detector aborts on any byte difference
from naive regeneration.

This already bit us: the single logical change "optimize `attempts_v` and
`tasks_v` together" was forced into two single-view migrations on main —
`20260614_224208_473ab33b__decouple_tasks_view.sql` and
`20260614_224400_add96e61__optimize_attempts_view.sql` — and it now *permanently*
requires `tasks_v` to stay decoupled from `attempts_v`.

The root cause is a category error: plain views are **derived, deterministic
code** (they hold no data and can be rebuilt from source at any time), but drizzle
treats them as **stateful schema** tracked in the migration snapshot chain. The
fix is to move plain views out of the stateful layer entirely: rebuild the whole
derived-view layer from source, in dependency order, as a post-migration step.
Then changing a view generates **no migration** and the ordering problem cannot
exist. Materialized views (none today) stay in the stateful/migration layer.

Two side investigations are folded in (see end): the benign boot-time drift
warning, and a confirmation that the duplicate-`sha8` hazard is already guarded.

## Current state (key files)

- View definitions (plain, non-materialized): `attempts_v`, `tasks_v`,
  `conversations_v` in
  `plugins/tasks/plugins/tasks-core/server/internal/schema.ts`; `agents_v` in
  `plugins/conversations/plugins/agents/server/internal/schema.ts`. Only
  `tasks_v → attempts_v` is interdependent.
- The view objects are queried as drizzle relations everywhere
  (`db.select().from(tasks|attempts|conversations|agents)` — see
  `tasks-core/server/internal/queries/*.ts`), so they **must remain valid
  `pgView` objects**; we only change *where they live* and *who manages their
  DDL*.
- drizzle picks views up by glob in
  `plugins/database/plugins/migrations/drizzle.config.ts`
  (`**/server/**/internal/{schema,tables}{,-*}.ts`). A file **not** matching that
  glob is invisible to `drizzle-kit generate`.
- Migration runner: `plugins/database/plugins/migrations/server/internal/runner.ts`
  (`runMigrations(db)`), called from `plugins/database/server/index.ts`
  `onReadyBlocking` after `awaitDbReady` + `warmPool`.
- Codegen post-process: `generateMigration()` in
  `plugins/framework/plugins/cli/bin/migrations.ts` already runs
  `renameMigrations()` + `regenerateJournal()` over freshly generated SQL — the
  natural home for a transition-only statement reorder. `sha8` is computed from
  final content, so reordering stays self-consistent.
- Snapshots store every view as `views["public.<name>"] = { name, schema,
  isExisting, materialized, definition }`, where `definition` is the fully
  *inlined* SELECT body and references to other views appear as quoted names
  (e.g. `tasks_v.definition` contains `"attempts_v"`). This makes the dependency
  graph derivable from the prior snapshot at codegen time.

## Design: derived-views registry + post-migration rebuild

### 1. New leaf plugin `plugins/database/plugins/derived-views/`

Owns the registry, dependency sort, SQL compilation, and the rebuild executor.
Pure/leaf so the CLI codegen and the runner can both touch it without dragging in
server init.

- `core/` — `defineView({ view, dependsOn })` pushes `{ name, view, dependsOn:
  string[] }` into a module-level array; `getRegisteredViews()` returns it;
  `topoSortViews(views)` returns dependency order (throws on cycle — fail loud).
  Dependency edges come from the explicit `dependsOn` list (authoritative, no SQL
  parsing).
- `server/` — `rebuildDerivedViews(db)`:
  1. `views = topoSortViews(getRegisteredViews())`
  2. `DROP VIEW IF EXISTS "public"."<name>"` in **reverse** topo order
  3. `CREATE VIEW "public"."<name>" AS <body>` in topo order
  - `<body>` is compiled from the `pgView` object via drizzle ORM:
    `new PgDialect().sqlToQuery(getViewConfig(view).query.inlineParams()).sql`
    (`getViewConfig`, `PgDialect` are public `drizzle-orm/pg-core` exports).
    `.inlineParams()` inlines string literals so the result is valid DDL with no
    bind params — **the one drizzle-API detail to verify first** (see Risks).
  - Runs inside one transaction; any failure throws and blocks boot (loud, before
    the server-ready barrier — no traffic yet).
  - Optional optimization (not required): hash the concatenated DDL into a small
    `__singularity_derived_views (ddl_hash)` row and skip the rebuild when
    unchanged, so steady-state boots do no DDL.

`defineView` registration runs at module load of each plugin's `views.ts`, which
is imported by that plugin's already-registered server barrel — so the registry
is fully populated before `onReadyBlocking` runs. No collected-dir codegen
needed.

### 2. Move view objects out of the drizzle glob

- tasks-core: move the three `pgView(...).as(...)` definitions from
  `internal/schema.ts` into a new `internal/views.ts` (not glob-matched). At the
  bottom of `views.ts`: `defineView({ view: attempts })`, `defineView({ view:
  conversations })`, `defineView({ view: tasks, dependsOn: ["attempts_v"] })`.
  The Zod schemas in `schema.ts` are built from **tables** (`_tasks`,
  `_attempts`, `_conversations`) and are unaffected; leave them in `schema.ts`.
  Update the server barrel to re-export the view objects from `./internal/views`
  instead of `./internal/schema`. **Ensure no glob-matched file
  (`schema.ts`/`tables.ts`) imports *or* re-exports the view objects**, or drizzle
  will still diff them.
- agents: same move — `agents` from `internal/schema.ts` to `internal/views.ts`,
  `defineView({ view: agents })`, update barrel re-export.

### 3. Wire the rebuild into boot

In `plugins/database/server/index.ts` `onReadyBlocking`, after `runMigrations(db)`
add `await rebuildDerivedViews(db)`. (Keeping it as a distinct step after the
runner — rather than inside `runMigrations` — keeps the migrations plugin free of
a dependency on derived-views.)

### 4. One-time transition migration (the only place ordering still matters)

Removing the views from the glob makes the next `drizzle-kit generate` emit a
single schema migration that **drops all four views** (they vanish from the
snapshot). That drop set includes `tasks_v → attempts_v`, so it hits the original
ordering bug. Handle it with a focused reorder in `generateMigration()`:

- After generation, parse the new `.sql` into `--> statement-breakpoint`
  statements. Identify `DROP VIEW "..."."<name>"` and `CREATE VIEW ...` lines.
- Build the view dependency graph from the **prior** snapshot's `views[*].definition`
  (scan each definition for the quoted names of the other views — verified
  detectable: `tasks_v.definition` contains `"attempts_v"`).
- Emit `DROP VIEW` statements in **reverse-topo** order and `CREATE VIEW` (none in
  this migration) in topo order; leave all non-view statements in place. Recompute
  `sha8` from the reordered content (already how `renameMigrations` hashes) so the
  hand-edit detector and `migrations-in-sync` stay green.

This reorder is general (not hardcoded to these four), so it also protects any
future **materialized** view kept in the stateful layer. After the transition,
plain views never appear in a migration again, so it lies dormant for them.

The runtime rebuild (step 1) recreates the four views immediately after the drop
migration applies — on existing DBs (drop → recreate) and fresh DBs (no view
migrations → create) alike.

### 5. Checks / docs

- `migrations-in-sync` and `snapshot-chain-intact` need no change: once views
  leave the glob they're absent from snapshots, so `drizzle-kit generate` produces
  nothing for them and the dry-run stays clean.
- The `db-schema` docgen facet finds `pgView(` by content scan, so views still
  appear in Studio/docs from `views.ts` — no change needed.
- Update `plugins/database/plugins/migrations/CLAUDE.md` and the new plugin's
  `CLAUDE.md`: plain views are derived code rebuilt every boot from
  `defineView`; to change one, edit `views.ts` (no migration); materialized views
  remain stateful.

### 6. Boot warning: clarify the message (chosen)

In `runner.ts`, reword the drift warning so it reads as expected-when-behind, not
a scary drift alert. Confirmed benign: a worktree DB is forked from main and
inherits main's `__singularity_migrations` rows; a branch that predates a
migration applied on main therefore has an applied hash with no on-disk file
(e.g. this worktree, branched at `f46180f2`, lacks the `473ab33b`/`add96e61` view
migrations). The DB already has those effects. New wording, roughly:

> `[migrate] applied hash <h> has no file on this branch — expected if this
> worktree predates a migration that landed on main (the DB already has its
> effects). Real drift only if you deleted a migration you authored.`

## Risks / verification notes

- **drizzle runtime SQL compilation is the load-bearing unknown.** Confirm
  `new PgDialect().sqlToQuery(getViewConfig(view).query.inlineParams()).sql`
  yields a param-free `SELECT` body matching the snapshot's `definition` for all
  four views, *before* building the rest. If the runtime API is awkward, fall
  back to a committed build-time artifact: a small codegen step writes each
  registered view's inlined `CREATE VIEW` SQL to `views.generated.sql`, guarded by
  a `derived-views-in-sync` check (mirrors `migrations-in-sync`), and the runner
  reads + executes that file. Same end state, no runtime drizzle internals.
- **Glob leakage**: double-check (via `./equin check migrations-in-sync`
  after the move, expecting it to *not* want a view migration) that no
  glob-matched file re-exports the view objects.
- **Already handled, no action**: the duplicate-`sha8` hazard (two distinct files
  sharing a content hash → runner silently skips the second) is structurally
  guarded by the existing `migration-hashes-unique` check; the lone real instance
  (`2a407315`, two `add_improve_pending_queue_top` files) is frozen main history
  the check intentionally tolerates, and `renameMigrations` now uniquifies custom
  migration bodies so the class can't recur on branch-local files.

## Implementation order

1. Verify the drizzle `getViewConfig`/`PgDialect`/`inlineParams` compilation
   against the four current views (throwaway script). Decide runtime-compile vs
   build-artifact based on the result.
2. Create `plugins/database/plugins/derived-views/` (core: `defineView`,
   `getRegisteredViews`, `topoSortViews`; server: `rebuildDerivedViews`).
3. Move views into `internal/views.ts` in tasks-core and agents; add `defineView`
   calls; update barrels; confirm `schema.ts`/`tables.ts` no longer reference the
   view objects.
4. Add the `reorderViewStatements()` post-process to `generateMigration()` in
   `cli/bin/migrations.ts`.
5. Wire `rebuildDerivedViews(db)` into `database/server/index.ts` `onReadyBlocking`.
6. Reword the runner drift warning.
7. `./equin build` to generate the transition (drop) migration; confirm the
   reorder produced reverse-topo drops and it applies cleanly.
8. Update CLAUDE.md docs.

## Verification (end to end)

- `./equin build` → server boots; the transition drop migration applies and
  `rebuildDerivedViews` recreates all four views. Confirm via
  `query_db`: `SELECT viewname FROM pg_views WHERE schemaname='public'` shows
  `attempts_v, tasks_v, conversations_v, agents_v`; and `SELECT count(*) FROM
  tasks_v` / `attempts_v` succeed (queries still resolve).
- Edit a view body in `views.ts` (e.g. tweak `attempts_v`), `./equin build`
  → **no new migration file appears** (the whole point), and the rebuild reflects
  the change after restart. `./equin check migrations-in-sync` passes.
- Make `tasks_v` and `attempts_v` interdependent-and-changed in one edit →
  `./equin build` succeeds with **zero** migrations (previously impossible).
- App smoke test at `http://att-1781522343-4bfw.localhost:9000`: tasks list,
  attempt view, agents render (the live-state resources that read these views).
- `./equin check` is green (type-check, migrations-in-sync,
  snapshot-chain-intact, migration-hashes-unique, plugin-boundaries).
