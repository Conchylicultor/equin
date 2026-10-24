# Decoded jsonb — the hand-written columns, and closing the rule

## Context

`sql-column` closed `text("x").$type<Union>()`. The entity tier
(`research/2026-08-26-global-decoded-jsonb-entity-columns.md`) closed every
column `defineEntity` derives from a field record, jsonb included — after which
**no storage arm asserts**.

What is left is the tier below it: the jsonb columns written by hand in a
`pgTable`. Each is `jsonb("x").$type<T>()`, which changes **no runtime behaviour
at all**. Postgres genuinely decodes the JSON, so the value is a real JS value —
what was never checked is its **shape**. A row written by older code, by hand, or
by a worktree on different code is handed to typed code as if it matched `T`.

`sql-column/no-asserted-column-type` is deliberately scoped to a literal
`text(` / `varchar(` / `char(` root, so it does not see these. Its own doc comment
says why the extension was gated rather than the tier being weaker: several of
these columns declare a TS type with **no zod schema in existence**, over
load-bearing tables (`page_blocks`, `reports`, `notifications`, every
`*_triggers` table), so a wrong schema is a hard crash on a core surface.

**Intended outcome:** every hand-written jsonb column either decodes through a
schema that really runs, or honestly reads back `unknown`. `jsonb(…).$type<T>()`
then has no remaining call site and the rule grows a `jsonb(` root — after which
the spelling is unspellable and the class of bug is gone at every tier.

Two facts from the entity tier this leans on directly:

- **A decoding jsonb column generates no migration.** `getSQLType()` is
  `"jsonb"`, drizzle-kit reads it into the snapshot with no branch on the column
  class, and `"jsonb"` is on its native-type whitelist — byte-identical DDL and
  snapshot, `.default()` included.
- **A live-data survey is what makes it safe to ship.** 478 569 rows were parsed
  against the real schemas before the entity tier deployed. The same gate applies
  here, and it is the load-bearing step.

And one property to design around: **a zod object decoder normalizes.** It
strips keys it does not declare, on read *and* on write. Where a column is an
open bag, the schema must be a `z.record`, which keeps every key by construction.

---

## The 25 hand-written columns, and what each becomes

### A. Open bags — `z.record(z.string(), z.unknown())`

The type was `Record<string, unknown>` and the value really is an arbitrary
per-producer bag. `z.record` is not a weak schema here, it is the **exact** one:
it verifies the value is a non-null object — precisely what
`Record<string, unknown>` claimed and nothing verified — and keeps every key, so
no producer's keys are normalized away. ~590 ns.

| column | rows (main) | why open |
|---|---|---|
| `reports.data` | 2 098 | per-`kind` payload; the kind's own schema parses it on write and on read |
| `notifications.metadata` | 4 864 | ~15 cross-plugin producers stamp their own keys |
| `search_documents.metadata` | 65 | the engine round-trips it and never interprets it |
| `*_triggers.job_with` (10 tables, `events/base-columns.ts`) | ~40 | one column serving 10 unrelated job-target `with` shapes |
| `job_waits.payload_json` | 3 | whatever event fired; `waitFor<T>` is generic per call site |
| `workflow_execution_steps.config` | 0 | per-step-type-plugin shape |
| `tweakcn_themes.raw_json` | 64 | a whole external tweakcn export |
| `trash_entries.meta` | 38 | "an opaque per-source payload" — see B |

### B. Columns whose declared type was already contradicted

- **`trash_entries.meta`** carries no `$type` (so it reads back `unknown`), yet
  four server readers cast the whole row `as TrashEntry` to get at it, and
  `TrashEntrySchema.meta` says `z.record(z.unknown())`. The column takes that
  schema; the casts go with it.
- **`backup_runs.manifest`** declares `BackupManifest` (`version: 2`,
  `sources: BackupSourceReport[]`), but the plugin's own wire schema is
  deliberately **wider** — `version: 1 | 2`, `sources` accepting the v1 fixed
  object — with a comment saying legacy rows stored the other shape. The TS type
  is a claim about rows that is already known to be false. The wire schema
  becomes the column's decoder and the column's type is derived from it, which is
  the whole point: one schema, and the type it really produces.

### C. Closed shapes with a schema that already exists

| column | schema | note |
|---|---|---|
| `backup_runs.target_results` | `z.array(BackupTargetResultSchema)` | exact match, needs `export` |
| `tweakcn_themes.presets` | `z.record(z.string(), PerGroupPresetSchema)` | lifted out of `TweakcnThemeSchema` so both read one declaration |
| `workflow_definitions.steps` | `z.record(z.string(), DefinitionStepSchema)` | exact match, already in the barrel this `tables.ts` imports |
| `workflow_execution_steps.next_step_mapping` | `z.record(z.string(), z.string())` | nullable → drizzle's, not the decoder's |
| `sonata_songs_ext_rhythm.bass` / `.chord` | `RhythmPatternSchema` | the same schema the HTTP write boundary already runs |
| `job_steps.result_json` | `z.object({ v: z.unknown() })` | the `{v}` box exists to round-trip `undefined`; `v` itself stays unknown |

### D. `conversations_ext_preprompt.icon` — and a duplication to collapse

`AvatarSpec` is recursive through `SvgNode.child`, so any schema needs `z.lazy`.
Three near-misses exist and none is reusable:

1. `fields/avatar/plugins/config`'s is private, adds a stray `.optional()`, and
   carries a **stateful** `getFieldResolver` transform — and importing it drags
   `react-icons/md` in as a value, which a `tables.ts` drizzle-kit loads
   *synchronously* must not do.
2. `icon-picker/core` owns the canonical `SvgNode` type but its barrel
   re-exports the ~2 MB generated icon map, so it is not a cheap import either.
3. `conversation-preprompt/shared/schemas.ts` already holds a **byte-exact**
   structural match, inline and anonymous inside a `.nullable()` wrapper, beside
   a *fourth* private re-declaration of the `SvgNode` interface.

So the schema gets a name where it already lives: `AvatarSpecSchema`, exported
from `conversation-preprompt/shared/schemas.ts`, annotated `ZodParser<AvatarSpec>`
against the canonical type (a **type-only** import — erased, so nothing heavy
loads). `PrepromptIconSchema` becomes `AvatarSpecSchema.nullable()`, and the
private `SvgNode` re-declaration is replaced by the canonical type. One
declaration fewer, and `tsc` now pins the schema to `AvatarSpec` so it cannot
drift.

### E. `page_blocks.data` — the branded one

`BlockData` is a **type-only brand** minted solely by `parseBlockData()`, and the
column's `$type<BlockData>` is what makes every write funnel through it — that
part is load-bearing and must survive.

A decoder is handed one value and never its row, so it cannot reach the block's
`type` and cannot re-run the per-type strict parse. What it *can* state is the
half of `BlockData` that holds for every block type — the payload is a JSON
object — and that half really runs. `z.record`, not a `z.object`: the per-type
schemas are contributed by ~35 block-type plugins, so an object schema here would
strip every key it has not heard of, i.e. all of them.

The brand therefore gets **one mint site with two callers**, one per direction:
`asBlockData()` in `core/schemas.ts`, called by `parseBlockData` (from a strict
parse against the type's own schema) and by `StoredBlockDataSchema` (on the way
out of the column, where the brand is re-established by provenance — the column's
write type is `BlockData`, so every row in it came through `parseBlockData`).
`parse-block-data.ts`'s "the ONLY cast" comment stays true, it just moves.

### F. Columns that stay bare `jsonb` — `unknown` is the honest answer

`dead_jobs.input`, `active_data_bindings.payload`, `entity_versions.snapshot`,
`workflow_execution_steps.input` / `.output`. None carries a `$type`; each is
genuinely "whatever the previous step / the registered source produced", and
every consumer respects the `unknown` (active-data safe-parses a caller-supplied
schema; the history engine hands the blob to its source's `restore`). This is the
same policy `fields/json/plugins/storage` already applies: a `z.unknown()` schema
gets a bare `jsonb` and no decoder, because there is nothing to verify.

---

## The write boundary the decoder exposes

`workflow_definitions.steps` was validated on write as `z.record(z.unknown())`
and then **cast** — `body.steps as Parameters<typeof createDefinition>[0]["steps"]`
— in two route handlers. Once the column decodes, a malformed create would throw
at the encoder rather than store garbage, which is better but still the wrong
place. The fix is the one the `SqlColumnError` message itself prescribes for a
failed write: parse at the boundary. `CreateDefinitionBodySchema` /
`UpdateDefinitionBodySchema` take `z.record(z.string(), DefinitionStepSchema)`,
the two casts are deleted, and a bad body is a 400 instead of a 500.

## The rule

`no-asserted-column-type` grows a second root. `TEXT_COLUMN_FACTORIES` becomes a
factory → tier map (`text`/`varchar`/`char` → text, `jsonb` → json), and the json
tier gets its own message: the remedy names `parsedJson`, and it states the
normalizing property up front, because that is the one thing an author porting a
site has to decide (`z.record` for an open bag, a `z.object` for a closed shape).
The `{ enum: [...] }` arm stays text-only — jsonb has no such config.

Bare `jsonb("x")` stays legal and untouched: it declares `unknown`, which is what
the column holds.

Two test fixtures still write the banned form and move to `parsedJson`:
`query-resource/…/compile-window.test.ts` and
`fields/tags/…/tags-filter-sql.test.ts`.

---

## Files

- `plugins/database/plugins/sql-column/lint/no-asserted-column-type.ts` (+ its test)
- One `tables.ts` per site — representative: `plugins/reports/server/internal/tables.ts`,
  `plugins/infra/plugins/events/server/internal/base-columns.ts`,
  `plugins/page/plugins/editor/server/internal/tables.ts`,
  `plugins/backup/server/internal/tables.ts`
- Schemas gaining a name / an `export`: `plugins/backup/shared/endpoints.ts`,
  `plugins/ui/plugins/tweakcn/core/endpoints.ts`,
  `plugins/conversations/plugins/conversation-preprompt/shared/schemas.ts`,
  `plugins/page/plugins/editor/core/schemas.ts`
- Cast removals: `plugins/apps/plugins/workflows/plugins/engine/{core/endpoints.ts,server/internal/routes.ts}`,
  `plugins/infra/plugins/trash/server/internal/{handle-list-trash,entry-lifecycle,purge,resources}.ts`
- Docs: `plugins/database/plugins/sql-column/CLAUDE.md` (the rule's open item
  closes), `plugins/database/CLAUDE.md`

## Verification

1. **The live-data survey, first and load-bearing.** Every schema *imported* from
   the repo, never transcribed; every non-null value of every row of all migrated
   columns parsed against it on the live `singularity` DB, reporting both parse
   failures and **stripped keys** (a normalizer that silently changes a stored
   value is the failure mode a pass/fail parse would miss). Empty tables are
   recorded as unproven rather than proven.
2. `./equin build` — the claim under test is that **no migration is
   generated**; `migrations-in-sync`, `type-check`, `eslint` and
   `plugin-boundaries` all green.
3. `./equin test` over the touched suites, plus a new
   `parsed-json`-through-`pgTable` case for the branded `page_blocks.data`
   decoder.
4. Both directions exercised on the deployed backend: create a page block, fire a
   report, record a notification, run a search index pass, and read each back —
   with no `SqlColumnError` on any log channel.
