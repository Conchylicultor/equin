# Raw tables behind DataViews become entities

Track: "DataView fields everywhere" (page `block-85963184-057d-4983-a5f0-c9183ae8d71c`), item **[Entities]**.

## Context

A DataView can derive its fields only from an entity (`entityRef` in core, `defineEntity(ref, meta)` on the server). About 17 tables behind lists are still raw `pgTable`s:

- **5 with a ref beside the raw table**: `page_blocks`, `deploy_servers`, `build_runs`, `release_runs`, `deploy_runs`. The ref and the table are two declarations of one row that agree only by convention.
- **12 with no entity**: `reports`, `dead_jobs`, `job_runs`, `notifications`, `entity_versions`, `trash_entries`, `agents`, `agent_launches`, `deploy_deployments`, `op_log_ops`, `backup_runs` (release/deploy history read `release_runs` / `deploy_runs`, covered above).

Outcome: every one is `defineEntity(xxxEntityRef, meta)`, its ref in the owning plugin's `core/`, with **no DDL change** (same columns, types, defaults, indexes, FKs, constraint names). Moving the lists onto `from` + `pick` is the next item, [Lists]; this item only gives them something to pick from.

## What the survey found (stale vs real blockers)

The comments explaining why tables stayed raw are mostly stale:

| Claimed blocker | Reality |
|---|---|
| Branded id (`idColumn(kind)`) | `idKindField(kind)` (`plugins/ids/core`) is the entity spelling, DDL-identical, accepted by `ids:pk-declared`. |
| `parsedText` enum columns | `enumTextField` / `parsedTextField` go through text storage's `decode` arm — same thing. |
| Partial unique / DESC indexes, CHECK | `meta.indexes(t)` is a passthrough to pgTable's extra-config (indexes **and** `check()`), `define-entity.ts`. |
| Cascading / self FKs | `meta.columns.<k>.references`. |
| `deriveUpdatedAt` wrapper | `meta.updatedAt.touchedBy` (same compiler, `compileFromTable`). |

Real gaps, each closed by a primitive rather than a per-table workaround:

1. **`text[]` has no field storage** (`build_runs.targets`, `deploy_deployments.hostnames`; the wire already says `stringListField`).
2. **Generated column** (`job_runs.id` = `job_name || ':' || seq`): `defineEntity` cannot spell `generatedAlwaysAs`.
3. **Columns that must never reach the wire** (`pid` ×3, `launchedFrom`/`legRunId`, `sshPublicKey`, `dedupKey`, page_blocks' `docRank`/`deletedAt`/`trashEntryId`): today they are simply absent from the ref. Once the ref IS the table they must be in it, and the browser must not be able to `pick` them. `serverOnly` exists only in the server `meta`, so the browser does not know.
4. **CLI manifest freeze**: the regenerating `./singularity build` CLI imports `run-ledger/server` (recorder + `_buildRuns`). `defineEntity` loads the field-storage eager manifest, which `cli:codegen-manifests-not-frozen` forbids in that closure.

## Design

### Primitives (first)

**A. `string-list` storage** — new `plugins/fields/plugins/string-list/plugins/storage/server` contributing `Fields.Storage({ type: stringListFieldType, build: (name) => text(name).array() })`, mirroring `plugins/fields/plugins/int/plugins/storage/server`. The eager manifest regenerates on build. A literal default (`{ default: [MAIN_COMPOSITION_ID] }`) keeps `build_runs`' DDL.

**B. Generated columns** — `EntityMeta.columns.<k>.generated: SQL` → `b.generatedAlwaysAs(sql)` in `define-entity.ts`; a generated key is excluded from the insert type like a defaulted one (extend `DefaultedKeys` or a sibling `GeneratedKeys` in `entities/server/internal/types.ts`). Throws if combined with `default`.

**C. Server-only declared on the ref** — `entityRef(name, fields, { serverOnly: [...] })` (`entities/core/internal/entity-ref.ts`). Rung 1/2 of the ladder: one declaration both runtimes read.
- `defineEntity(ref, meta)` takes server-only from the ref; `meta.serverOnly` is removed from the ref overload (tsc), kept on the `(name, fields)` spelling.
- `liveCollection({ from: ref, pick })`: the `pick` / `carry.pick` key type excludes the ref's server-only keys (tsc), and `live-fields.ts`' untyped-caller check fails loudly too.
- `wireSchema(fields, serverOnly)` already exists in entities/core, so the browser schema stays equal by construction.

**D. CLI keeps off the table** — split `build/plugins/run-ledger`: a `cli/` barrel holds the recorder and `settleDeadInflightRun`, written as hand SQL naming only the columns they touch (the insert already is, `recorder.ts:104` — and the same schema-skew argument applies to its UPDATE/SELECT: the CLI runs new code against the previous build's schema, so it must never bind to the current table definition). `server/` holds the entity. The build CLI imports `run-ledger/cli`. Same treatment, only if the check trips, for the deploy CLI's `_deployServers` reads (`cli/plugins/deploy/cli/internal/target.ts`) and the release CLI.

### Per-table pattern

For each table:
1. `core/`: `export const xxxFields = { … } satisfies FieldsRecord` + `xxxEntityRef = entityRef("xxx", xxxFields, { serverOnly })`. If a collection already has `LISTED`/`CARRIED` records over the same columns, the ref's record is built from them (no third copy); where the collection's factory disagrees with the column (`notifications.count`, `job_runs.seq`/`durationMs`/`attempt`/`maxAttempts` are `floatField` over `integer`), the ref uses the column's true type (`intField`) and the collection keeps its own until [Lists].
2. `server/internal/tables.ts`: `const xxxEntity = defineEntity(xxxEntityRef, { primaryKey, columns: { defaults, names, references }, indexes, updatedAt })`; `export const _xxx = xxxEntity.table` (drizzle-kit discovery and all existing importers keep working — JS keys and column names unchanged).
3. Delete the "why it stays raw" comments; ids move to `idKindField(kind)`.
4. Build; the generated migration must be **empty** for that table. Any DDL diff is a bug in the declaration, not something to commit.

### Tables

| Table | Notes |
|---|---|
| `deploy_servers` | `sshPublicKey` server-only; `touchedBy` moves into meta. Simplest — do first to prove the pattern. |
| `release_runs` | Ref exists; add `pid` server-only, `idKindField`, partial unique + 2 indexes. |
| `deploy_runs` | Ref exists; add `pid`, `launchedFrom`, `legRunId` server-only; FK cascade to deployments; `status` column stays text. |
| `deploy_deployments` | `hostnames` via (A); FK to servers; 2 unique indexes; `updatedAt` meta. |
| `build_runs` | `targets` via (A), `pid` server-only, recorder split (D). |
| `page_blocks` | Add `docRank`/`deletedAt`/`trashEntryId` server-only (wire unchanged), self-FKs, 2 partial uniques, CHECK `page_blocks_trash_flags_agree` via `indexes`, `data` as `jsonField({ schema: StoredBlockDataSchema })`; keep drizzle-kit loadability (ref stays in `block-entity/core`, off the Lexical barrel). id stays plain text (existing `ids:pk-declared` debt exemption keeps its path). |
| `reports` | `idKindField(reportIdKind)`, unique `(fingerprint, worktree)`, `updatedAt` meta. |
| `notifications` | `dedupKey` server-only, partial index on `variant`. |
| `entity_versions` | `snapshot` stays a field (`jsonField(z.unknown())`) — large, just never picked. |
| `trash_entries` | Already 1:1 with `idKindField`; build the ref from its records. |
| `dead_jobs` | `input` as `nullable(jsonField(...))`. |
| `job_runs` | `id` via (B); `slot` in the record. |
| `agents` / `agent_launches` | `parsedTextField` model/icon, `rank` field, self-FK cascade, `updatedAt` meta; `isFolder` and the latest-conversation join stay collection-computed. |
| `op_log_ops` | Not reached by the CLI (only `op-log/server`; confirm with the check). `doublePrecision` → `floatField`. `_opLogIngestCursor` (bigint, no list) stays raw. |
| `backup_runs` | Plain-text pk (existing exemption), `pid` server-only, partial unique, json columns with their schemas. Its runs arm keeps reading `_backupRuns` columns. |

Session shape: one session, two builds — (1) primitives A–D + the 5 ref tables, (2) the 12 others.

## Verification

- `./singularity build` after each batch: **no new migration SQL** for any converted table (`git status` under the migrations folder); `migrations-in-sync`, `type-check`, `ids:pk-declared`, `cli:codegen-manifests-not-frozen`, `plugins-doc-in-sync` green.
- Tests: `./singularity test plugins/infra/plugins/entities plugins/network/plugins/live plugins/build/plugins/run-ledger plugins/fields/plugins/string-list` plus new unit tests: string-list storage round-trip, generated column DDL, a picked server-only key rejected (tsc `@ts-expect-error` + runtime).
- `query_db` on the worktree: rows of each list unchanged (counts / a sample row per table).
- Browser (`browser_*` MCP on the worktree build): open Reports, Notifications, Debug → Jobs (dead + runs), Trash, history dialog, Agents, Deploy (servers, deployments, history), Runs (build/release/deploy/backup), Pages sidebar — each renders as before.
- Run a `./singularity build` from the worktree itself (exercises the split recorder: a `build_runs` row appears and finishes).

## After

Update the track page: tick [Entities] items, status line, and file the next task ([Lists]).

## Outcome (2026-10-18)

Done: 15 of the 16 tables are `defineEntity(ref, …)` (all but `page_blocks`); the build generated **no migration**.

Departures from the plan above:

- **C, server-only columns:** declared on the server, not on the ref — `defineEntity(ref, serverFields, meta)`. The ref stays the pure wire record, so a list cannot `pick` a server column at all (nothing to type-check), and the server fields are `serverOnly` by construction; `meta.serverOnly` is refused on the ref spelling (tsc + runtime).
- **D:** the CLI-facing ledger code is `run-ledger/shared/` (hand SQL, no table import); the recorder is the `run-ledger/cli` barrel, the server barrel re-exports the shared settle. The deploy/release CLIs did not trip `cli:codegen-manifests-not-frozen`, so they were left alone.
- **`change-feed:producer-writes`** resolved a producer's table only from a `defineEntity("<name>")` literal; it now follows `defineEntity(<ref>)` to the ref's `entityRef("<name>")` in another file (`entityRefIdentifiers` / `resolveEntityRefNames`).
- **backup:** the `manifest` / `target_results` decoders moved from `backup/shared` to `backup/core/run-schemas.ts`, which also deleted the runs arm's duplicate copy (`runs-arm/core/internal/payload-schemas.ts`).
- **`page_blocks` deferred.** Its ref's `rank` is the wire `Rank` value object (`rankWireField`) while the column holds the raw key, and its `data` column carries the `BlockData` brand whose decoder lives in `page/editor/core` — which `block-entity` cannot import (cycle), and moving it touches ~65 importers and changes the browser's write type. Needs its own design.
