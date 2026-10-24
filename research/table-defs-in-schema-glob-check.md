# Check: `table-defs-in-schema-glob`

## Problem

`drizzle-kit` discovers tables by a **filename glob** (in
`plugins/database/plugins/migrations/drizzle.config.ts`):

```
plugins/**/server/**/internal/tables.ts
plugins/**/server/**/internal/tables-*.ts
plugins/**/server/**/internal/schema.ts
plugins/**/server/**/internal/schema-*.ts
```

A `pgTable(...)` (or a table-factory call such as `Attachments.defineLink(...)`)
in a server file whose name is **not** matched by this glob is invisible to
migration generation. The failure is **silent and dangerous**: drizzle sees the
previously-known table as dropped and emits a spurious `DROP TABLE` migration,
with no error. `./equin build` then auto-generates that DROP and the agent
commits it — `migrations-in-sync` passes because the migrations *do* match
drizzle's (now wrong) view of the schema. Nothing validates drizzle's view
against the true set of tables.

This was hit moving the page block↔attachment link between modules; the link
only reappeared after renaming the file to a glob-matched name.

## Invariant to enforce

> Every concrete table definition lives in a drizzle glob-matched schema file,
> so it can never silently vanish from migration generation.

Concrete table definitions come in two forms, both of which must live in a
glob-matched file:

1. A direct `pgTable("literal", ...)` call.
2. A call to a **table factory** — a function that wraps `pgTable(<dynamicName>)`
   and produces one concrete migrated table per call. The codebase has four,
   all confirmed drizzle-migrated (consumers re-export `<handle>.table` — or
   destructure `table:` — from the glob file):

   | factory | defined in (dynamic-`pgTable` body) |
   |---|---|
   | `defineLink` | `plugins/infra/plugins/attachments/server/internal/define-link.ts` |
   | `defineExtension` | `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts` |
   | `defineTriggerEvent` | `plugins/infra/plugins/events/server/internal/event.ts` |
   | `defineCollection` | `plugins/primitives/plugins/collections/core/internal/table-builder.ts` (currently 0 call sites) |

The factory **definition files** legitimately contain a dynamic-name `pgTable`
in a non-glob file — that is the factory body, parameterized, and produces no
concrete table at that site. They are excluded.

**Current tree is clean**: every `defineLink`/`defineExtension`/`defineTriggerEvent`
call site is already in a `tables.ts` / `tables-*.ts` / `schema-*.ts` file, and
every literal `pgTable` lives in a `tables.ts`. The one outlier
(`plugins/framework/plugins/server-core/scripts/backfill-pushes.ts`) inlines a
table reference in a standalone `scripts/` file outside `server/**` — outside the
scan domain, so not flagged.

## Design

A new built-in check at
`plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts`.

**Scan domain**: `plugins/**/server/**/*.ts`, excluding `*.test.ts`. (Only
`server/**/internal/` files are migrated; tables anywhere else are irrelevant.
`scripts/` siblings and `core/`/`web/` are outside the domain.)

**Glob-matched file set** is computed from the **single source of truth** —
`drizzle.config.ts`. The check reads that file, extracts the `schema: [...]`
string array, resolves each pattern against the migrations plugin dir to a
repo-relative glob, and expands it with `Bun.Glob` against the repo root. No glob
duplication. If the array can't be parsed, the check fails loudly.

**Two rules** over candidate files (after excluding glob-matched files):

- **Rule 1 — stray table definition**: a `pgTable(` occurrence in a candidate
  file that is **not** a registered factory-definition file → violation. (Catches
  raw `pgTable` in a mis-named server file, and a new unregistered factory body.)
- **Rule 2 — stray factory call**: a call to any registered factory name
  (`defineLink(`, `defineExtension(`, `defineTriggerEvent(`, `defineCollection(`)
  in a candidate file → violation. (Catches the reported bug: a factory call
  moved to a non-glob file.)

Matches are found with `grepCode` (`maskStrings: true`, since these are code
constructs) so comments and strings never match.

**Self-maintaining factory list**: a single `TABLE_FACTORIES` array of
`{ name, definedIn }` pairs drives both the Rule-1 exclusion (`definedIn`) and the
Rule-2 enforcement (`name`). Adding a new server-defined factory: its factory
body's `pgTable` is flagged by Rule 1 until you add an entry — and that same
entry forces you to register the call `name` for Rule 2. The footgun cannot be
reintroduced silently. (Core-defined factories like `defineCollection` live
outside the server scan domain; they are registered manually and documented in
the check's CLAUDE.md.)

**Message/hint** lists each offending `file:line` and explains: table
definitions must live in a drizzle schema file (`server/**/internal/tables.ts`,
`tables-*.ts`, `schema.ts`, or `schema-*.ts`); move the `pgTable` / factory call
there (for a factory, re-export `<handle>.table` per the convention) or the table
silently vanishes from migrations.

## Why a check, not broadening the glob

Broadening the glob to scan all `server/**/internal/*.ts` would make drizzle-kit
import every server internal file during codegen — many import runtime-only deps
(db connections, handlers) that should not run during codegen. The `tables.ts`
convention deliberately keeps schema files pure and isolated (see the comment in
`drizzle.config.ts`). The check preserves that isolation while closing the gap.
