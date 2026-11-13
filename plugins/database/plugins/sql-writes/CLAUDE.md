# sql-writes

Every hand-written SQL write in source, **parsed by Postgres's own grammar**
(libpg_query — the `libpg-query` WASM build of the same major as the embedded
server, 18) and validated against **the schema the code declares**. Check
`sql-writes:fit`.

Why: on 2026-11-08 a raw upsert (`stopUpsert`, runtime-sdk) set
`"updated_at" = now()` on a table whose `updated_at` is derived — its
touchedBy trigger refuses an explicit write — and nothing caught it until the
database raised P0001 at runtime and main crash-looped. The set of derived
columns was declared in code; the raw write could still name one.

## What it checks

For each INSERT / UPDATE / DELETE / MERGE — top-level, in a CTE, in a
subquery:

| issue | meaning | exemptable as |
|---|---|---|
| `derived` | it writes a derived `updated_at` (registered by `defineEntity` / `deriveUpdatedAt`) in an UPDATE position — a SET, ON CONFLICT DO UPDATE SET, MERGE's UPDATE — or a generated column anywhere. (An INSERT may give `updated_at`: the trigger is BEFORE UPDATE, and that writes history — the raw twin of `insertWithUpdatedAt`.) | **never** — the database refuses it every time |
| `unknown-table` | its target is not declared: no drizzle schema table, no hand-written `CREATE TABLE` | `sql-writes:fit:schema` |
| `unknown-column` | a written column (or ON CONFLICT target, or a column a WHERE / RETURNING reads off the target) is not a column of it | `sql-writes:fit:schema` |
| `positional-insert` | an INSERT with no column list | `sql-writes:fit:schema` |
| `missing-required` | an INSERT leaves out a NOT NULL column nothing in the database fills (no DB default — a JS `$defaultFn` does not count —, not generated, identity or serial) | `sql-writes:fit:schema` |
| `dynamic` | its target table or a written column is not spelled in source (an interpolated value or list), or a `sql` tagged write does not parse | `sql-writes:fit:dynamic` |

## Every hand-written write is declared (`sql-writes:fit:hand-written`)

Fitting the schema is not enough: a write that COULD go through a typed handle
should, because the handle is what makes a wrong column a tsc error before it
is a runtime one. So every write site outside an e2e script is a
`hand-written` issue unless the plugin that owns the file declares it, in its
own `exempt/index.ts`, under `sql-writes:fit:hand-written` with the reason the
typed path cannot express it (`./equin exempt list --rule
sql-writes:fit:hand-written`) — AND each write in it is bound by its own
marker comment on its statement (or any enclosing node up to it):

```ts
// sql-writes:hand-written — WITH RECURSIVE walk up the folder tree feeding the write
const rows = await executeRows(exec, { query: sql`WITH RECURSIVE …` });
```

The manifest says which plugin owns the exception and why (kind, reason, a debt
task); the marker says which statements it covers. So a NEW raw write fails
`./equin check` even in a declared file, until it is typed or marked; a marker
opening a comment that binds no write is a stale marker, a marker that binds
MORE than one write (a comment above a `switch`, an object of statements, two
writes in one statement) is refused — one marker declares one write, so a write
added under it later is not covered — and a declared file
whose writes are gone is an unused exemption — both fail too. Only a comment
that OPENS with the marker is one (prose naming it is not), and SQL text inside
a literal is never read as a comment (`sites.ts`'s `markerOf`).

The typed path, in the order to reach for it:

| you want | write it with |
|---|---|
| insert / update / delete by column | drizzle's builders on the table handle (`db.insert(t).values`, `.update(t).set`, `.delete(t).where`) |
| an upsert, a conditional one | `.onConflictDoUpdate({ target, set, setWhere })`; an extension's `upsert` / `upsertQuery(id, values, { onlyIf })` |
| rows from a query | `.insert(t).select(qb.select({...}).from(…))` |
| per-row values in one statement | `.update(t).set({ col: sql\`v.col\` }).from(sql\`unnest(…) AS v(…)\`)` |
| a capped log (keep the newest N) | `trimToNewest(exec, t, { key, newestFirst, keep })` (`database/server`) |
| several writes, atomically, no idle window | `writeAtomically(exec, [builders…])` (`database/server`) |

What stays hand-written, declared `kind: "sanctioned"`: a data-modifying or
recursive CTE (one write feeding the next in one statement, a `WITH RECURSIVE`
walk feeding an UPDATE), a set-based `INSERT … SELECT` over a hand-written
aggregation, graphile-worker's own tables, a generator writing names it
computes from a declaration or the catalog (rollups, the extension handle,
PGlite's clock shift, the data-root migration), the migration runner's own
ledger, and the build CLI's ledger write (new code against the previous
schema). A write to a table made by imperative DDL (no drizzle handle yet) is
`kind: "debt"`, naming the task that gives it one.

**e2e scripts are out of this rule's scope** (still parsed and fitted): they
drive the deployed app from outside and may import only `core` / `e2e`
barrels, so the server's typed tables are unreachable from them, and an
out-of-band row is often what the script verifies (the change feed carrying
it to the page).

## The declared schema (`check/internal/model.ts`, `schema-probe.ts`)

No hand-kept list. Two sources:

- **Drizzle** — a subprocess (`schema-probe.ts`, run like
  `derived-updated-at:declared`'s probe: `bun --bun` from the migrations plugin
  dir) `require()`s every schema-glob file and reports every exported
  `PgTable`: physical columns, which are required, which are unwritten (a
  generated column, or the column `registeredDerivedUpdatedAt()` names).
  `IMPERATIVE_PUBLIC_TABLES` names the public tables made outside drizzle.
  Its answer is a plugin record (`closureRecord`, `check/internal/run-probe.ts`):
  keyed by the probe script's and every schema file's module Merkle key (each
  over its import closure), its input and the npm code they import — so the
  subprocess runs once per distinct schema closure host-wide, and a pass after
  an edit no schema file reaches is a lookup (~0.5 s of graph walk, against a
  1–20 s subprocess depending on host load). Its input and answer name files
  repo-relative (the probe is handed the checkout root as its argument), since
  a record is shared by every checkout.
- **Hand-written DDL** found in source: `CREATE TABLE` (temp included) declares
  a table and its columns; `ALTER TABLE … ADD / DROP COLUMN` and `RENAME
  COLUMN` apply after every CREATE. An imperative table whose DDL is generated
  (a rollup's) is known by name only, and its columns are not checked.

## Finding the writes (`check/internal/sites.ts`, folded by `sites.scan.ts`)

Every `.ts` / `.tsx` under `plugins/` outside the `test`, `research` and
`generated` categories, minus modules importing `bun:sqlite` (SQLite's SQL, a
different database). Each file's sites and marker comments are a function of
its own bytes, so they are a **fold** kept along the directory tree
(`plugin-records`' `foldRepoFiles`): a pass after a one-line edit parses the
edited file, not the ~2.6k files the word prefilter passes (56 hold a site).
A hole whose value another file decides is recorded **deferred** (an import,
an exported `const` of a schema file) and followed afterwards
(`check/internal/resolve.ts`, through the run's source analysis): ~10 files,
only those the holes name. A site is:

- a drizzle tagged template — a tag spelled `sql` or `…Sql`;
- an untagged string / template literal that *starts* like a statement (WITH /
  INSERT / UPDATE / DELETE / MERGE / CREATE / ALTER, after comments) — what
  `pool.query` and `sql.raw` take. One that does not parse is prose and is
  skipped; a tagged one that does not parse is a `dynamic` issue.

Out of scope: plpgsql bodies (`CREATE FUNCTION … $$…$$`, `DO`) — a string to
the parser; migration `.sql` files (written against the schema of their own
time; `data-migration-dml-only` owns them); test code; SQL assembled by string
concatenation (`"insert into " + t`), which is no literal to parse.

## Holes: `${…}`

Resolved from the source alone, no type checker: a local `const`, an import
followed through barrels' re-exports (the source analysis's module
resolution, the repo project's `paths` over the run's file set), `sql.raw(…)` / `sql.identifier(…)` of a constant string, a property
path (`sdkAgentStops.table`). A chain ending at an export of a schema-glob file
is evaluated by the probe (a table renders as its quoted name, a column as
drizzle renders it, `"table"."col"`). In a drizzle tag a constant string is a
bound value; in plain interpolation it is text.

Anything else — a parameter, a call, a computed list — renders as a placeholder
identifier `__h<N>__`. A placeholder parses as a value, a name or a condition;
where the grammar wants a clause (`VALUES ${rows}`, `SET ${sets}`,
`WITH ${ctes}`), the parse fails at it and it is retried as an assignment list,
a query, a row list, a CTE list, a parenthesised list, or nothing
(`statements.ts`'s `FILLERS`). Where a placeholder lands decides: as a value it
is harmless; as the target table or a written column, the write is `dynamic`.

**Dynamic names are refused unless declared**: a generator that writes names it
computes from a declaration or the catalog (the rollup compiler, the guarded
`upsertQuery`, PGlite's clock shift) declares `sql-writes:fit:dynamic` in its
own `exempt/index.ts` with the reason (`./equin exempt list --rule
sql-writes:fit:dynamic`). graphile-worker's own tables
(`graphile_worker._private_*`) are written by the jobs plugin and
`events-test` under sanctioned `sql-writes:fit:schema` exemptions: graphile's
migrations create them, nothing here declares them.

## The other rungs

The check is rung 3 for raw SQL; typed writes are rung 2:

- A derived `updatedAt` is out of the table's insert model (`HasGenerated`), so
  a typed `.values()`, `.set()` or `onConflictDoUpdate({ set })` naming it is a
  tsc error — `defineEntity` (`UnwrittenKeys`), `defineExtension`, and a raw
  table through `derivedUpdatedAt()` (`deriveUpdatedAt` requires it). Writing
  history on INSERT (a seed) is `insertWithUpdatedAt`
  (database/derived-updated-at).
- The upsert that needed raw SQL — "insert only while another row exists" — is
  an extension handle's `upsertQuery(id, values, { onlyIf })`, so it has no
  reason left to be hand-written (`stopUpsert`, task-title's short-title store).

Tests: `check/internal/validate.test.ts` — the original 70c82060b3 statement
(refused) and its fix (passes), every issue kind, clause-shaped holes, DDL.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Every hand-written SQL write (INSERT / UPDATE / DELETE / MERGE, in CTEs too) parsed with Postgres's own grammar (libpg_query) and checked against the schema the code declares — drizzle tables with their derived updated_at and generated columns, plus hand-written DDL: known tables and columns, required columns inserted, no write to a derived column (check sql-writes:fit).

<!-- AUTOGENERATED:END -->
