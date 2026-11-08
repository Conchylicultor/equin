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

## The declared schema (`check/internal/model.ts`, `schema-probe.ts`)

No hand-kept list. Two sources:

- **Drizzle** — a subprocess (`schema-probe.ts`, run like
  `derived-updated-at:declared`'s probe: `bun --bun` from the migrations plugin
  dir) `require()`s every schema-glob file and reports every exported
  `PgTable`: physical columns, which are required, which are unwritten (a
  generated column, or the column `registeredDerivedUpdatedAt()` names).
  `IMPERATIVE_PUBLIC_TABLES` names the public tables made outside drizzle.
- **Hand-written DDL** found in source: `CREATE TABLE` (temp included) declares
  a table and its columns; `ALTER TABLE … ADD / DROP COLUMN` and `RENAME
  COLUMN` apply after every CREATE. An imperative table whose DDL is generated
  (a rollup's) is known by name only, and its columns are not checked.

## Finding the writes (`check/internal/sites.ts`)

Every `.ts` / `.tsx` under `plugins/` outside the `test`, `research` and
`generated` categories, minus modules importing `bun:sqlite` (SQLite's SQL, a
different database). A site is:

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
followed through barrels' re-exports (`ts.resolveModuleName` with the repo's
`paths`), `sql.raw(…)` / `sql.identifier(…)` of a constant string, a property
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
