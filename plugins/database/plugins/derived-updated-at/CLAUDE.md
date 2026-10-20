# derived-updated-at

A table's `updated_at`, maintained by the database from a per-column
declaration instead of stamped by hand at every write site. Plans:
`research/2026-09-25-global-derived-updated-at.md`,
`research/2026-09-25-global-derived-updated-at-raw-tables.md`.

## The rule: a column named `updated_at` means derived

Every drizzle schema table with a column physically named `updated_at` declares
how it moves — no exceptions, enforced by the `derived-updated-at:declared`
check below. A write-time or heartbeat stamp ("when did this process last
persist the row") is a different fact and must be spelled differently
(e.g. `persisted_at`, `last_seen_at`).

## Declaring it

Two declaration sites, one compiler path:

- **An entity** — `defineEntity`'s `meta.updatedAt: { touchedBy }` in
  `infra/entities` (see its CLAUDE.md). That half lives there; this plugin is
  the part the database plugin can import without a cycle (entities pulls in
  the fields capability loader, whose barrels reach `@plugins/database/server`).
- **A raw drizzle table** — wrap the `pgTable` in `deriveUpdatedAt`:

  ```ts
  import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";

  export const agents = deriveUpdatedAt(
    pgTable("agents", { id: …, name: …, rank: …, createdAt: …, updatedAt: … }),
    { touchedBy: { name: true, rank: true, id: false, createdAt: false } },
  );
  ```

  `deriveUpdatedAt<T extends TableWithUpdatedAt>(table: T, { touchedBy }: {
  touchedBy: TableTouchedBy<T> }): T` returns the table unchanged, and compiles
  + registers at module eval, like `defineEntity`. `TableTouchedBy<T>` is TOTAL
  over `keyof T["$inferSelect"]` minus `updatedAt`, each rule a
  `TouchRule<column value>` — a new column nobody classified, a misspelled
  transition value (on a `$type<Union>()` / enum column) and a table with no
  `updatedAt` are all tsc errors.

Both call `compileFromTable(table, touchedBy, where?)`: it reads the physical
column names and SQL types off `getTableColumns(table)` and runtime-checks what
the types promise (an `updatedAt` column exists, `touchedBy` classifies every
other column exactly once, the table is in the public schema). `where` names
the declaration site in the totality error.

## The pieces

- `compileDerivedUpdatedAt({ table, updatedAtColumn, columns })` (internal) —
  pure. Turns each column's `TouchRule` into one BEFORE UPDATE row trigger:
  - `true` → `NEW.c IS DISTINCT FROM OLD.c`;
  - `{ into, outOf }` → `(NEW.c IS DISTINCT FROM OLD.c AND (NEW.c IN (into) OR OLD.c IN (outOf)))`
    (`null` as `IS NULL`; scalar values only, a jsonb column is refused);
  - `{ exceptKeys }` (jsonb object columns only) → `(NEW.c - ARRAY[keys])
    IS DISTINCT FROM (OLD.c - ARRAY[keys])`: any change but one confined to
    the listed top-level keys — a presentation key riding inside a content
    payload (`page_blocks.data`'s `icon`). Keys are typed against the column's
    object type; a non-jsonb column or an empty list is refused;
  - `false` → nothing.

  The function sets `updated_at := now()` iff the OR of those holds (no counted
  column ⇒ it never moves after insert), and RAISEs (`<table>.updated_at is
  derived (declared by its touchedBy); do not write it`) when a write changes
  `updated_at` itself — rewriting its own value is not a change and passes.
  INSERT is untouched (`defaultNow()`).
- `registerDerivedUpdatedAt(spec)` / `registeredDerivedUpdatedAt()` — the module
  registry both declaration sites fill at module eval; the same table declared
  twice with different rules throws.
- `installDerivedUpdatedAt(db, specs)` — called inside the migrations plugin's
  one boot schema-layer transaction (`applySchemaLayer`, from `database/server`'s
  `onReadyBlocking`) right after the migrations, with
  `registeredDerivedUpdatedAt()`; each table's transaction is then a savepoint.
  Follows the
  `jobs/superseded-trigger.ts` precedent: the DDL's sha256 is the trigger's
  COMMENT, so an up-to-date trigger is a catalog-only no-op; otherwise, per
  table, `pg_advisory_xact_lock` + re-check + `CREATE OR REPLACE FUNCTION` /
  `TRIGGER` + COMMENT in one transaction. Then it asserts every trigger is
  present with its signature, and throws if not. A missing table throws.

  `specs` is required, never read from the registry inside: a process that
  never loaded the schema files would read it empty. The registry is
  process-wide, so a DB test on a throwaway database passes exactly its own
  table's spec
  (`entity.derivedUpdatedAt`, or `compileFromTable(table, touchedBy)`) rather
  than the registry (which holds every other suite's tables too).

## The check: `derived-updated-at:declared`

`check/index.ts` closes the set. A subprocess (`check/internal/declared-probe.ts`,
run like `schema-files-loadable`'s probe: `bun --bun`, from the migrations
plugin dir, drizzle-kit's environment) `require()`s every schema-glob file
(`schemaGlobFiles`), walks their top-level exports for drizzle `PgTable`s with a
column physically named `updated_at`, and fails for any whose table is not in
`registeredDerivedUpdatedAt()` — naming the table and its file. The probe
imports the registry through the same `@plugins/…/derived-updated-at/server`
specifier the schema files use, so it reads the one registry they filled. A
schema file that fails to load fails the check too (its tables went unseen).

It is static rather than a boot assert because a composition namespace loads
only some plugins, so its registry is legitimately partial; the schema globs are
the complete, runtime-independent set of drizzle tables. Hand-written DDL
(`CREATE TABLE IF NOT EXISTS` on boot) is outside it — follow the rule anyway.

Tests: `server/internal/compile.test.ts` (compiler output),
`server/internal/from-table.test.ts` (reading a table, runtime backstops, type
tests), `check/declared.test.ts` (the probe over a fixture schema file). The
real-DB suite that drives the trigger end to end — an entity and a raw
`deriveUpdatedAt` table — and the defineEntity ≡ deriveUpdatedAt spec equality
are in `infra/entities/server/internal/`
(`install-derived-updated-at.test.ts`, `derived-updated-at.test.ts`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Derived updatedAt: compiles a table's per-column touchedBy rules (declared in defineEntity's meta.updatedAt, or deriveUpdatedAt on a raw pgTable) into a BEFORE UPDATE trigger that sets updated_at = now() only when a counted column really changed and RAISEs on any app write to it; a registry filled at module eval, the boot installer (signature-in-COMMENT, advisory-locked, asserted) the database plugin runs right after migrations, and a check that every schema table with an updated_at column declares one.
- Cross-plugin:
  - Imported by:
    - `active-data`
    - `apps/chord/curriculum`
    - `apps/chord/song-index`
    - `conversations/conversations-view/grouped`
    - `database`
    - `database/migrations`
    - `debug/profiling/op-log/op-store`
    - `infra/entities`
    - `primitives/data-view/custom-columns/values`
    - `primitives/data-view/view-order`
    - `ui/theme-engine/saved-themes`
- Server:
  - DB schema: `plugins/database/plugins/derived-updated-at/server/internal/from-table.ts`
  - Exports (types):
    - `DerivedUpdatedAtSpec`
    - `TableTouchedBy`
    - `TableWithUpdatedAt`
    - `TouchRule`
  - Exports (values):
    - `compileFromTable`
    - `deriveUpdatedAt`
    - `installDerivedUpdatedAt`
    - `registerDerivedUpdatedAt`
    - `registeredDerivedUpdatedAt`

<!-- AUTOGENERATED:END -->
