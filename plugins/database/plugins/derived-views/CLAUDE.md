# derived-views

Plain (non-materialized) DB views are **derived code, not stateful schema**.
They hold no data and are deterministic functions of the tables, so this plugin
rebuilds the entire plain-view layer from source on **every boot** instead of
tracking each view through the drizzle migration chain.

## Why

drizzle-kit emits view `DROP`s in alphabetical, not dependency, order. When two
interdependent views (e.g. `tasks_v` → `attempts_v`) change in one migration,
Postgres rejects the out-of-order drop. Treating plain views as migration schema
is a category error. Moving them out of the migration glob and rebuilding them
post-migration removes the whole class of ordering bug: changing a view
generates **no migration at all**.

## How it works

- Each owning plugin defines its views in a `server/internal/views.ts` file —
  **not** `schema.ts`/`tables.ts`, so the drizzle codegen glob
  (`**/internal/{schema,tables}{,-*}.ts`) never sees them.
- The plugin declares each view as a **server contribution** on its plugin
  definition: `contributions: [View({ view })]` (and
  `View({ view, dependsOn: ["other_v"] })` for an interdependent view), where
  `View` is imported from `@plugins/database/plugins/derived-views/server`. The
  framework collects all contributions at boot **before any `onReadyBlocking`
  runs**, so the view set is complete regardless of module import order — there
  is no "view registered in a module nothing imported" footgun. (This replaced
  the old `defineView()` import-side-effect registry, whose registration
  silently depended on something importing `views.ts`.)
- `rebuildDerivedViews(db, views)` (server) is the last step of the migrations
  plugin's **one boot schema-layer transaction** (`applySchemaLayer`, called from
  the database plugin's `onReadyBlocking` with `View.getContributions()`), after
  the migrations, the derived `updatedAt` triggers and the rollup tables. It
  `DROP VIEW IF EXISTS`s every view in **reverse** dependency order and
  `CREATE VIEW`s them in forward order (skipped when the compiled layer's
  signature is unchanged and every view exists). Any failure throws, rolls the
  whole layer back — migrations included — and blocks boot.

### Views never block a migration

- `dropDerivedViews(db)` (server) drops every view **live** in `public`, in one
  statement, at the start of that same transaction — **only when a migration is
  pending**. A live view would otherwise block any migration that drops or
  retypes a column it reads ("other objects depend on it"), and neither
  drizzle-kit (which never sees views) nor a hand edit (push regenerates schema
  migrations; the phaser rejects `CREATE/DROP VIEW`) can put a `DROP VIEW` in
  front of it. The rebuild then finds views missing and recreates them.
- It drops the live set, not the declared one, because the view in the way is
  the one the previous code created, which current declarations may not name.
- Because drop, migrations and rebuild commit together, the previous backend
  never reads a missing view during a hot-swap: it waits on the transaction's
  locks, then sees the new layer. A failure anywhere leaves the old views, the
  old columns and the ledger untouched.
- With nothing pending no view is dropped, and the rebuild takes its
  skip-when-unchanged path — the steady-state restart opens no lock window.
- The view set is an argument, not read inside the rebuild, because the
  `migration-applies-clean` check also rebuilds the views (in its rolled-back
  dry-run on main's DB) from a process that never boots. It gathers the same set
  with `View.from(definitions)` over main's server barrels.
- The view body is compiled from the drizzle `pgView` object via
  `compileCreateView` (core), which inlines all params into standalone DDL.
- `dependsOn` lists the SQL **name** strings of other views (e.g. `"attempts_v"`),
  not the JS objects — so a cross-plugin view dependency never forces an import.

## To change a plain view

Edit its `views.ts` and `./equin build`. **No migration is generated.** The
rebuild reflects the change on the next server start. Interdependent views can be
changed together in one edit — the dependency-ordered rebuild handles it. To add a
**new** view, define the `pgView` in `views.ts` and add `View({ view })` to the
owning plugin's server `contributions`.

## Materialized views

Materialized views hold data and are stateful — they stay in the migration layer
(`schema.ts`), not here. (None exist today.)

## The imperative-table allowlist (`core/internal/imperative-tables.ts`)

This plugin's `core` leaf is also the shared sink for `IMPERATIVE_PUBLIC_TABLES` —
the allowlist of public tables created imperatively (`CREATE TABLE IF NOT EXISTS`)
rather than through drizzle. It lives here because every consumer already depends
on this leaf and it has no back-edge; see the module header for why it is *not* in
`@plugins/database/core`.

It is a **record keyed by the name of the constant** holding each table name, and
both projections are derived from it, so they cannot drift:

| export | is | consumed by |
|---|---|---|
| `IMPERATIVE_PUBLIC_TABLES` | the record | the shorthand guard in `imperative-create-table-allowlisted` |
| `IMPERATIVE_PUBLIC_TABLE_NAMES` | its values (table names) | `orphaned-db-tables` (diffs against the live DB) |
| `IMPERATIVE_PUBLIC_TABLE_CONSTS` | its keys (identifiers) | `imperative-create-table-allowlisted`, `table-defs-in-schema-glob` |

**Write each entry shorthand — `{ MY_TABLE }`, never `{ ALIAS: MY_TABLE }`.** The
two static checks enforce a *textual* coupling (the constant must appear on the
`CREATE TABLE` line; a `pgTable` read handle must be passed the constant, not a
string literal), so they need the identifier NAMES — which the old `string[]` of
values did not publish, leaving each check to regex them back out of this file's
text. The shorthand keys are what make those names declared data. The invariant is
proved, not asserted: `imperative-create-table-allowlisted` checks that every key
names an export of this `core` barrel holding that exact value, so an aliased key
or a constant missing from the barrel fails loudly at the push gate. Adding a
constant therefore means three edits: declare it, add it shorthand to the record,
and re-export it from `core/index.ts`. See
`research/2026-07-29-global-imperative-tables-declared-const-names.md`.

## Boundaries

- `core/` — the `RegisteredView` type, `topoSortViews`, `compileCreateView`, and
  the imperative-table allowlist above.
  Pure sort + SQL compilation; may import `drizzle-orm`. No DB access, no
  registry state.
- `server/` — the `View` server contribution (the registration surface other
  plugins import) and `rebuildDerivedViews(db)`. `rebuildDerivedViews` takes
  `db` as a parameter so it never imports `@plugins/database/server` (which
  would cycle: database/server calls it).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Rebuilds plain DB views from source on every boot, in dependency order. Plain views are derived code (declared via the View contribution), not stateful migration schema.
- Server:
  - Uses: `primitives/log-channels.defineLogSink`
  - Exports (types): `DeclaredView`
  - Exports (values):
    - `dropDerivedViews`
    - `rebuildDerivedViews`
    - `View`
- Core:
  - Uses: `framework/product-name.LEGACY_IDS`
  - Exports (types): `RegisteredView`
  - Exports (values):
    - `assertImperativePublicTable`
    - `ATTEMPT_CONV_AGG_TABLE`
    - `ATTEMPT_PUSH_AGG_TABLE`
    - `compileCreateView`
    - `DERIVED_TABLE_OBJECT_STATE_TABLE`
    - `DERIVED_TABLE_STATE_TABLE`
    - `DERIVED_VIEW_STATE_TABLE_NAME`
    - `IMPERATIVE_PUBLIC_TABLE_CONSTS`
    - `IMPERATIVE_PUBLIC_TABLE_NAMES`
    - `IMPERATIVE_PUBLIC_TABLES`
    - `LIVE_STATE_CHANGELOG_HORIZON_TABLE`
    - `LIVE_STATE_CHANGELOG_TABLE`
    - `LIVE_STATE_SNAPSHOT_TABLE`
    - `LIVE_STATE_TRIGGER_STATE_TABLE`
    - `MIGRATIONS_TABLE_NAME`
    - `PAGE_CONTENT_EDITED_AT_TABLE`
    - `TASK_LATEST_CONVERSATION_TABLE`
    - `topoSortViews`
- Cross-plugin:
  - Imported by:
    - `apps/chord/video-availability`
    - `conversations/agents`
    - `database`
    - `database/derived-tables`
    - `database/migrations`
    - `tasks/tasks-core`

<!-- AUTOGENERATED:END -->
