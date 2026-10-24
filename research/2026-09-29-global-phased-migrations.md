# Phased migrations: views out → expand → data → contract → views in

## Context

Migration incidents keep coming back in new forms. The common cause is that **the order migrations apply in is set by filename timestamps, and nothing records the real dependencies between steps**. There are three layers, each ordered by its own rule:

| Layer | Written by | Ordered by |
|---|---|---|
| Schema (drizzle diff) | generated; hand-edits refused at push | **re-stamped to push time** by `regen-migrations` |
| Data (`--custom-migration`) | hand-written, DML only | its original timestamp |
| Views (`View` contributions) | derived code, outside the list | always after every migration |

A real change often needs **views out → add schema → move data → remove schema → views in**. None of the three rules can express that, and every cross-layer case has broken in its own way:

- **2026-09-29 (conv-1790527702-7lgj).** `ALTER TABLE agents DROP COLUMN icon_svg_nodes` failed on main with "other objects depend on it". Main's live `agents_v` view still reads the column, and views are rebuilt only after migrations. A hand-added `DROP VIEW` was refused by push's hand-edit guard. The agent's stopgap is `dropDerivedViews` in the runner (uncommitted on `att-1790527702-zic0`). It drops the views in the first migration's transaction, but they are only rebuilt in a later one, so the old backend reads missing views during the hot-swap.
- **07-10 and 08-08.** A backfill needed a table its own branch created. The reset re-stamped the schema migration *after* the backfill, so the backfill hit `relation does not exist`, and only when main had moved. The response was a stated invariant, the two-push recipe, and the `data-migration-reset-stable` check (`research/2026-08-08-global-migration-ordering-invariant.md`).
- **06-17.** drizzle-kit dropped interdependent views in alphabetical order, so views moved out of drizzle into derived code.

There is a second, smaller defect. A data migration keeps its authoring timestamp, but main applies it at push time. A from-scratch replay therefore runs it *before* main migrations it actually ran after. Fresh installs and releases replay every migration: `ensureBaseDatabase` creates an empty base DB.

**Intended outcome.** Ordering becomes a declared property of each push's schema migration, not an accident of wall-clock time. One push can express add → backfill → drop. A view can never block a column change. The boot schema layer applies atomically. The two-push recipe, the ordering invariant and its check can all be deleted.

## Design

### 1. A phased schema migration (generation time)

In `generateMigration` (`plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts`), a new step runs **before `renameMigrations` hashes the content**, where `reorderViewStatements` sits today. It rewrites each freshly generated schema `.sql` into marked sections:

```sql
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "x" (...);
ALTER TABLE "agents" ADD COLUMN "icon" text;
-- singularity:phase contract
ALTER TABLE "agents" ALTER COLUMN "icon" SET NOT NULL;
ALTER TABLE "agents" DROP COLUMN IF EXISTS "icon_svg_nodes";
-- singularity:claims
-- 20260927_182347__remap_saved_icons_to_symbols
```

- **Why generation time:** the runner stays dumb (it splits on marker lines and parses no SQL at boot). A reviewer sees the phases in the diff. The file is generator output, so filename hash = content hash and the hand-edit guard is unchanged.
- **Splitting:** merged files are not reliably separated by `--> statement-breakpoint`, and `DO $$…$$` bodies contain `;`. Hoist the masked statement splitter (`maskTrivia` plus the splitter in `plugins/framework/plugins/tooling/plugins/checks/plugins/data-migration-dml-only/check/index.ts`) into `plugins/database/plugins/migrations/core`. The dml-only check, the phaser and `fork-schema-drift` then share one implementation.
- **Classifier:** a closed table in `migrations/core`. It **replaces and absorbs** `classifyMigrationSql` in `core/internal/destructive.ts`, which `fork-schema-drift` uses. Any statement it does not recognise **fails generation loudly**, naming the statement.
  - **expand** (permissive; existing data and code stay valid):
    - `CREATE TABLE`, `CREATE INDEX` (non-unique), `CREATE SEQUENCE/DOMAIN`
    - `ADD COLUMN` that is nullable or has a `DEFAULT`
    - `ALTER COLUMN SET/DROP DEFAULT`, `DROP NOT NULL`
    - `DROP CONSTRAINT`, `DROP INDEX`
    - `ENABLE/DISABLE ROW LEVEL SECURITY`
    - `RENAME COLUMN/TABLE`: renames are expand, so data migrations see the new names. This is documented.
  - **contract** (restrictive, or destroys data):
    - `DROP TABLE`, `DROP COLUMN`, `DROP SEQUENCE/TYPE`
    - `SET NOT NULL`, `ALTER COLUMN … SET DATA TYPE`
    - `ADD CONSTRAINT`, including drizzle 0.28's `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT … EXCEPTION … END $$` foreign-key form
    - `CREATE UNIQUE INDEX`
  - **Auto-split:** `ADD COLUMN c T NOT NULL` with no default becomes expand `ADD COLUMN c T` plus contract `ALTER COLUMN c SET NOT NULL`. That makes "new required column + backfill" a single push.
  - **Rejected:**
    - `CREATE/DROP VIEW`: views are derived code. This lets `reorderViewStatements` and its tests be deleted.
    - `ALTER TYPE … ADD VALUE`: a new enum value cannot be used in the transaction that adds it, and the whole schema layer is now one transaction. No `pgEnum` exists today; the error message says so.
- **Claims:** a new schema migration claims every **branch-local** data migration that is not on `origin/main`, sorts before it, and is not claimed by another branch-local schema migration.
  - The identity is `<timestamp>__<slug>`, i.e. the filename minus its hash, because `rehashBranchLocalDataMigrations` changes only the hash.
  - After push's `regen-migrations`, the single `merged_*` file claims all of the branch's data migrations. That makes a push one explicit group.

### 2. Group-ordered runner (apply time)

A new pure `planSchemaSteps(files, appliedHashes)` in `plugins/database/plugins/migrations/server/internal/runner.ts` sits next to `planMigrations`, whose duplicate-hash skip it keeps. It walks the files in timestamp order:

- **Legacy file** (no phase markers: every migration already on main, and all data migrations): one step at its own position. Historical replay order is unchanged.
- **Phased schema migration S:** emits `S.expand`, then the data migrations S claims (timestamp order), then `S.contract`.
- **Claimed data migration at its own position:** skipped; it runs inside its claimer's group.
- **Unclaimed data migration** (a data-only push): runs at its own position, as today.
- **Validation:** a claim that resolves to no file, a data migration claimed twice, or a claim that sorts after its claimer **throws**.
- Steps of already-applied files are dropped. Each file's ledger row is inserted after its last step.

Grouping is per push, never global. Phasing all pending migrations together would break the from-scratch replay (for example, a table dropped in one push's contract and recreated in a later push's expand).

### 3. One transaction for the boot schema layer

A new `applySchemaLayer(db, inputs, { commit })` in the migrations plugin replaces the four separate boot steps in `plugins/database/server/index.ts`. It runs them in **one transaction**:

1. If any step is pending, drop every live public view (`dropDerivedViews`, taken from the `att-1790527702-zic0` branch).
2. Run the phased steps from `planSchemaSteps`, plus their ledger rows.
3. `installDerivedUpdatedAt(tx, specs)`. It already accepts a `Tx` internally; widen its public signature.
4. `rebuildDerivedTables(tx, specs)`: pass specs instead of reading `DerivedTable.getContributions()` inside it.
5. `rebuildDerivedViews(tx, views)`.

- **Why one transaction:** the old backend keeps serving during a hot-swap. It now waits on locks instead of reading missing views, and a failure at any step leaves the whole layer untouched.
- **Steady state:** nothing is pending, no view is dropped, and each step takes its existing skip-when-unchanged path, so no new lock window opens.
- **Known cost:** on a boot *with* pending migrations, derived-tables' trigger DDL now holds its source-table locks until the one commit, not its own. This is accepted because it happens only on migration boots, which already block readers.
- **Inputs are required arguments** (`{ views, derivedTables, updatedAtSpecs }`), never registry reads inside the function. This follows 1aacd12897: a registry read in a non-booted process silently comes back empty. Boot passes the contributions.
- **Dry run:** `dryRunPendingMigrations` becomes `applySchemaLayer(…, { commit: false })`, which throws the rollback sentinel, so the dry run *is* boot and cannot drift from it.
  - The `migration-applies-clean` check (`plugins/database/plugins/migrations/check/index.ts`) generalises `check/internal/declared-views.ts` to collect `View` **and** `DerivedTable` contributions from main's server barrels.
  - The updatedAt specs come from the module registry the barrel imports fill. Assert it is non-empty.
  - The 60 s statement timeout and 1 s lock timeout stay.

### 4. Checks and docs

- **Delete** `data-migration-reset-stable`, its test, and the ordering-invariant sections and two-push recipe in `plugins/database/plugins/migrations/CLAUDE.md` and `plugins/infra/plugins/entity-extensions/CLAUDE.md`.
- **Add** `migration-phases-valid`. It runs `planSchemaSteps` over the files on disk, so claim errors and an unphased branch-local schema migration fail at build, not at boot. It also re-runs the classifier over each branch-local schema migration.
- `fork-schema-drift` switches to the shared classifier.
- Update the docs:
  - `migrations/CLAUDE.md`: the phase model, what counts as expand or contract, what a data migration sees (after expand, before contract), and that renames are expand.
  - `derived-views/CLAUDE.md`: views never block a migration.
  - `regen-migrations/CLAUDE.md`: the merged file claims the branch's data migrations.

## Sequencing with the in-flight icons branch

`att-1790527702-zic0` carries `dropDerivedViews` plus a runner hook. Let it land as is to unblock the column drop, then build this on top. Step 3 moves its call into `applySchemaLayer` and closes the gap where views are missing during the hot-swap. If this lands first instead, the icons branch drops its runner edit and keeps only its migration.

## Critical files

- `plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts`: phaser step before `renameMigrations`; claims; delete `reorderViewStatements*`.
- `plugins/database/plugins/migrations/core/`: splitter, classifier (absorbing `internal/destructive.ts`), phase-marker grammar.
- `plugins/database/plugins/migrations/server/internal/runner.ts`: `planSchemaSteps` and `applySchemaLayer`; `dryRunPendingMigrations` goes through it.
- `plugins/database/server/index.ts`: one `applySchemaLayer` call replaces the four boot steps.
- `plugins/database/plugins/derived-tables/server/internal/rebuild.ts` and `derived-updated-at/server/internal/install.ts`: take the tx and explicit specs.
- `plugins/database/plugins/derived-views/server/internal/drop.ts`: from the icons branch.
- `plugins/database/plugins/migrations/check/`: `migration-applies-clean` inputs; new `migration-phases-valid`; delete `data-migration-reset-stable`.
- The `data-migration-dml-only` check: import the hoisted splitter.

## Verification

- **Unit tests** (`./equin test plugins/database/plugins/migrations plugins/framework/plugins/cli/plugins/migrations`):
  - The classifier and splitter over **every statement of every schema migration on disk**. All classify, which pins drizzle 0.28's real output shapes, including the one-line `…;CREATE…` merges and `DO $$` foreign keys. Separate cases for auto-split, `CREATE VIEW` rejection, and unknown-statement failure.
  - `planSchemaSteps`: legacy-only history keeps its order; expand → claimed data → contract; data-only push; each validation error; partially applied groups.
- **DB tests** (`createTestDb`):
  - A from-scratch replay of the entire `data/` directory plus the layer succeeds. This protects fresh installs and releases.
  - One group with a new NOT NULL column, a backfill, a dropped old column, and a live view reading the dropped column applies in one push.
  - A failure injected in the view rebuild leaves the ledger, the columns and the old views intact (atomicity).
- **End to end:** run `./equin build` in a scratch branch that reproduces the icons case (a `View` reading a column that the branch drops, plus a data migration that reads the column first). Confirm `migration-applies-clean` passes against main and the worktree boots. Then `./equin check`.
