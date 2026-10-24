# Fields-unified entities: one source of truth for storage + wire + UI

> **Supersedes** the schema-first approach in
> [`2026-06-17-global-zod-derived-db-tables.md`](./2026-06-17-global-zod-derived-db-tables.md).
> That doc proposed `dbTable(zodSchema)` (derive the table *from* the zod schema). This doc
> pivots to the **field-first** model the user committed to: a field type owns storage + wire +
> UI, and an *entity* is a record of fields from which the table, the zod wire schema, and the
> resource row-shape are all generated. The `dbTable(zodSchema)` engine is a **divergent branch**
> that this model obsoletes (see "Relationship" below) and should not be built.

## Context

Adding a column to the `slow_ops` table today requires hand-syncing three places — the Drizzle
table (`server/internal/tables.ts`), the zod schema (`core/resources.ts`), and a hand-written row
projection in the live-state loader (`server/internal/resources.ts`). The projection is a pure
identity map that **silently drops** any column a contributor forgets to forward (TypeScript does
not warn on an omitted property); `recentSamples` was missed on first pass. This is the surface
symptom of a deeper gap: **there is no single artifact from which a table's storage, its wire
contract, and its UI all derive.**

The user's articulated north star:

> The ideal single source of truth: the `fields/` type registry becomes the place where a field
> type declares **storage + wire + UI** in one identity, and an **entity** is a record of fields
> from which the **table, the zod schema, and the resource row-shape** are all generated.

This realizes that, staged so each part ships independently.

## Current state (what the codebase actually has)

There are **three parallel field abstractions, none built on the others** (one is dead and will be deleted — see Stage 1):

| Type | Home | UI | wire (zod) | storage (drizzle col) | consumers |
|---|---|:--:|:--:|:--:|---|
| `FieldIdentity` | `plugins/fields/core/internal/types.ts` | ✅ `label`/`icon`/`extends`/`coerce` | ❌ | ❌ | config_v2, data-view (cell/filter) |
| `FieldDef<T>` | `plugins/config_v2/core/internal/types.ts` | via token | ✅ hand-written `schema` | ❌ | ~40 config importers |
| `FieldInstance<T>` *(to delete)* | `plugins/primitives/plugins/collections/core/internal/field-types.ts` | ❌ | ✅ `_zodSchema` | ✅ `_columns(name)` | **none** — orphaned Phase-1 code |

**Why `collections` has zero consumers (decisive context).** `defineCollection` was Phase 1 of a 6-phase
plan (`research/2026-05-13-global-define-collection.md`) to kill the 4-layer user-editable-list
boilerplate across 5 plugins (prompt-templates, quick-prompts, category-colors, excluded-path-state,
agents). Only Phase 1 (core type system) shipped. Phase 2 — the ergonomic field factories
(`textField`/`avatarField`) it needs to be usable — was never built, because the parallel
unified-fields initiative (`plugins/fields/`, 3 weeks later) became the canonical field home and
obsoleted a second factory set under `collections/`. So `defineCollection` is unusable as shipped
(only the raw `createFieldInstance` escape exists, also uncalled) and no plugin was ever migrated.
**Decision: delete `collections` outright** rather than rebase it — its list-semantics features
(rank, create/update schema variants, bundled live-state resource) are re-grown as opt-in features of
`defineEntity` when a real consumer needs them. The original 5-plugin boilerplate-kill goal stays
valid and is revived as `defineEntity` adopters (Stage E).

Key facts:

- The **existing unified-fields roadmap** (`research/2026-06-06-global-unified-fields-primitive.md`,
  an 8-task chain) built `FieldIdentity` + the `fields.identity` registry slot + data-view
  `cell`/`filter` capability slots. **Tasks 1–7 landed; task 8 (remove the `config_v2/core`
  `FieldType` re-export shim) is pending.** That roadmap was deliberately scoped to config +
  data-view surfaces — **Drizzle, DB tables, and table-from-fields generation appear nowhere in
  it.** `FieldIdentity` is intentionally storage-free and browser-safe ("no `fs`, no server
  imports").
- The fields system is a **TYPE × CAPABILITY matrix** (one axis = field type; the other =
  capability: config, table-cell, filter), sparse, with `extends`-chain fallback. New capabilities
  are added as per-type sub-plugin contributions keyed by the type token.
- `collections.buildTable` (`plugins/primitives/plugins/collections/core/internal/table-builder.ts`)
  already builds a `pgTable` from a field record via `field._columns(name)` — **the closest existing
  prototype, worth mining before deletion** for its `_columns(name) => PgColumnBuilderBase` shape (the
  reference for Stage A's storage capability) and its `create`/`update` schema derivation. But it
  hardcodes managed-list semantics: `id` always `text` PK, mandatory `rank`, always-on
  `createdAt`/`updatedAt`, `primaryKey` throws, always creates a live-state resource — too narrow for
  an arbitrary system table (uuid PK, no rank, jsonb-of-nested-zod). Lift the patterns, then delete it
  (Stage 1).
- drizzle-kit discovers tables by **evaluating** the glob-matched `tables.ts` modules at runtime
  (`plugins/database/plugins/migrations/drizzle.config.ts`), so helper-built tables are picked up
  — proven by `defineExtension`/`defineLink` (10+ committed migrations). The
  `table-defs-in-schema-glob` check has a `TABLE_FACTORIES` registry any new factory must join.
- zod is **v3** (`^3.23.8`); the `json` field type already accepts an arbitrary `z.ZodType<T>` (the
  intended home for jsonb columns like `CallerBreakdown[]` / `SlowOpSample[]`).

## The unification design

Add **two new capabilities** to the existing fields matrix, plus a general entity factory:

1. **`storage` capability (server runtime).** Per field type, a contribution
   `(name: string, opts) => PgColumnBuilderBase` (or a multi-column record, as `collections._columns`
   allows). Lives on the **server** runtime, keyed by the field-type token — this is what keeps
   `drizzle-orm/pg-core` out of the browser bundle (the boundary win, achieved through the matrix
   rather than through `dbTable`).
2. **`wire` capability (core).** The zod fragment for a field's value. Largely formalizes what
   `config_v2/FieldDef.schema` already carries; needed so a field record can be turned into a
   `z.ZodObject` generically. Value-instance specific (enum options, json's nested schema), so it
   lives on the field *spec*, not the type identity.
3. **`defineEntity(name, fieldRecord, meta)` (server + core split).** Generalizes
   `collections.buildTable` without the list assumptions. Core derives the `z.ZodObject` wire schema
   (browser-safe, plain zod) from each spec's `wire`; server builds the Drizzle table from each
   spec's `storage`. The inferred row type is `z.infer<wireSchema>` **by construction**, so a
   live-state loader returns rows with **no projection** and field-set drift is unrepresentable.

Boundary split (preserves the rule): **core** holds the field specs + derived wire schema; **server**
holds the storage capabilities + the built table. Both read the *same* field record.

## Relationship to the earlier `dbTable(zodSchema)` proposal

`dbTable(zodSchema)` is **schema-first** (`zod → table`); this is **field-first**
(`fields → {zod, table}` in parallel). In the field-first model the table is built from each field's
`storage` contribution and the zod schema is itself derived — so there is **no `zod → table` step**,
and `dbTable`'s zod-introspection engine would be discarded. It is therefore a **divergent branch,
not a stage**, and should not be built if we commit to this roadmap. (Its only lasting idea — "delete
the projection, return rows directly" — survives as Stage 0 / Stage D.)

## Staged roadmap (each stage gets its own detailed plan)

Dependencies in brackets. Each stage is independently shippable.

### Stage 0 — Stop the bleeding on slow-ops *(optional, ship today)* [none]
No new primitive. In `slow-ops/server/internal/resources.ts`, delete the `.map(...)` projection and
`return db.select().from(_slowOps).orderBy(desc(_slowOps.totalMs))` directly; add a compile-time
guard `type _Check = Expect<Equal<typeof _slowOps.$inferSelect, SlowOp>>` so any table/schema drift
is a loud `tsc` error instead of a silent drop. Removes the footgun immediately; replaced by Stage D.

### Stage 1 — Delete the dead `collections` plugin [none, do first]
Mine the patterns worth keeping (`_columns(name) => PgColumnBuilderBase`; `create`/`update` schema
derivation) into this doc / Stage A notes, then delete. Checklist for a green build:
- Remove `plugins/primitives/plugins/collections/` (8 files: `CLAUDE.md`, `package.json`, `core/index.ts`, 5 `core/internal/*`).
- Remove the `defineCollection` entry from `TABLE_FACTORIES` (~line 36) **and** its co-located test
  assertion (~line 71, `isCandidatePath(".../collections/.../table-builder.ts")`) in
  `plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts`.
- `bun install` + `./equin build` regenerates docs (`plugins-compact.md`, `plugins-details.md`,
  `primitives/CLAUDE.md`) — `plugins-doc-in-sync` covers the removal. No code imports exist (verified),
  so no other edits. Drops the parallel field model from day one, leaving only `fields/` and `config_v2`.

### Stage A — `storage` capability in the fields matrix [1]
Add a server-runtime capability: `fields/plugins/<type>/plugins/storage/server` contributes a column
builder keyed by the type token. Cover the primitives needed for real tables: `text`, `int`, `float`,
`bool`, `date`/`timestamp`, `uuid`, `json` (jsonb with a supplied nested zod). Reuse the
(now-deleted) `collections._columns` shape as the reference. No consumer yet; unit-test the column
output per type.

### Stage B — Unified field-spec atom + `fieldsToZodObject` [A]
Define one field-spec that bundles the type token (→ UI via existing identity), per-instance options,
and the `wire` zod fragment, with `storage` resolved via the registry server-side. Provide
`fieldsToZodObject(fieldRecord): z.ZodObject` (core). Converge `config_v2/FieldDef` toward this single
atom (with `collections/FieldInstance` already deleted, only two models remain to unify).

### Stage C — `defineEntity(name, fieldRecord, meta)` [A, B]
General entity factory. `meta` supplies storage-only detail with no field analog: primary key,
defaults, unique/composite indexes, snake_case overrides. **No** mandatory `rank`/`createdAt`. Core
exposes `entity.schema` (derived `z.ZodObject`); server exposes `entity.table` (built from `storage`).
Register `defineEntity` in `TABLE_FACTORIES`
(`plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts`).
Must support the `slow_ops` shape: uuid PK, `doublePrecision` floats, jsonb-of-nested-zod, timestamptz,
a unique index. Unit-test the derived DDL + schema.

### Stage D — Migrate slow-ops as first adopter [C]
Re-express `SlowOp` as a field record (the nested `CallerBreakdownSchema`/`SlowOpSampleSchema` become
the `json` fields' value schemas). Table + wire schema + row-shape all derive; delete the projection;
the live-state loader returns `db.select()` rows directly. The footgun is structurally gone, and
slow_ops rows can feed a data-view cell/filter for free. **Verify zero schema drift** — `./equin
build` must generate no new migration; if it does, adjust `meta` until the DDL is byte-identical.

### Stage E — Grow list-semantics into `defineEntity` on demand (revive the boilerplate-kill) [C]
No second primitive. When the first real consumer needs them, add **opt-in** features to `defineEntity`:
standard columns (`rank`/`createdAt`/`updatedAt` presets), `create`/`update` schema variants, and an
optional bundled live-state resource. Then revive the original goal `collections` never reached —
migrate the user-editable-list boilerplate plugins (prompt-templates, quick-prompts, …) onto
`defineEntity`. Features are pulled into the one primitive only when earned by a consumer, not built
speculatively. End state: a **single** field model (`fields/`) + a **single** table/schema primitive
(`defineEntity`).

### Stage F — Broaden adoption + guardrail *(optional)* [E]
Migrate other 1:1 table-backed loaders (`conversations/summary`, …; leave genuinely transforming
loaders like `sonata/library` alone). Add a check/lint that flags hand-written row projections that
should be entities, so the footgun cannot reappear.

## Critical files

- `plugins/fields/core/internal/types.ts` — `FieldIdentity` (add nothing here; storage is a separate capability)
- `plugins/fields/plugins/<type>/` — new `storage` (server) capability sub-plugins (Stage A)
- `plugins/primitives/plugins/collections/` — **delete** (Stage 1); mine `_columns`/schema-derivation patterns first
- `plugins/config_v2/core/internal/types.ts` — `FieldDef` to converge (Stage B)
- new `defineEntity` primitive home (Stage C) — likely `plugins/database/plugins/<entity>/` or `plugins/infra/plugins/<entity>/`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts` — drop `defineCollection` from `TABLE_FACTORIES` + its test (Stage 1); register `defineEntity` (Stage C)
- `plugins/debug/plugins/slow-ops/{core/resources.ts,server/internal/{tables,resources}.ts}` — Stage 0 + Stage D
- `plugins/database/plugins/migrations/drizzle.config.ts` — schema glob (reference)

## Verification (per stage)

- **Stage 0:** `./equin check type-check` passes with the guard; intentionally renaming a `SlowOp` field without updating the table fails `tsc` (then revert).
- **Stages A–C:** `bun test` on the new capability/factory units; `./equin check` (boundaries, type-check, `table-defs-in-schema-glob`).
- **Stage D:** `./equin build` generates **no new migration** (DDL identical); `migrations-in-sync` clean; open the Slow Ops debug pane at `http://<worktree>.localhost:9000` (Debug → Slow Ops) and confirm all fields incl. `recentSamples` render; `mcp__singularity__query_db` confirms `slow_ops` structure unchanged.
- **Stage 1:** `./equin check` green after deletion (`plugins-doc-in-sync`, `table-defs-in-schema-glob`, `type-check`, boundaries); `rg defineCollection` returns nothing.
- **Stage E:** the migrated boilerplate plugins (prompt-templates, …) produce **no migration drift** (DDL identical to their hand-written tables) and their list UI/CRUD behaves as before.

## Decided

- **Delete `collections`** rather than rebase it (zero consumers, orphaned Phase 1). List-semantics
  features grow into `defineEntity` on demand — **one** primitive, not two.

## Open decisions for the user

1. **Stage 0 now, or wait?** Ship the cheap compile-guard fix immediately, or leave slow-ops as-is until Stage D lands.
2. **`defineEntity` home** — under `database/` (DB concern) or `infra/` (cross-cutting server primitive).
3. **Sequencing of the pending fields task 8** (remove `FieldType` shim) — independent of this roadmap, but touches the same `fields/` tree; do it before Stage A or in parallel.
