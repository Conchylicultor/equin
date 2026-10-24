# Derived `updatedAt` for raw-`pgTable` tables, and closing the set

Follow-up to `2026-09-25-global-derived-updated-at.md` and
`2026-09-25-global-derived-updated-at-remaining-entities.md` (§6).

## Context

Every `defineEntity` table with an `updatedAt` field now gets it from the
database: a BEFORE UPDATE trigger compiled from a total, per-column `touchedBy`
declaration. The 16 tables built with raw drizzle `pgTable` (or hand-written
DDL) still stamp `updated_at` by hand at each write site. That causes spurious
bumps on no-op writes, and silent misses when a site forgets the stamp.

There are two gaps:

1. **The declaration is only reachable through `defineEntity`.** A raw table
   cannot opt in without being rewritten as an entity.
2. **Nothing closes the set.** A new raw table with an `updated_at` column
   compiles, migrates and ships with no guarantee at all. That is how these 16
   happened.

**Inventory result.** No `updated_at` on these 16 tables has a reader that
depends on today's touch semantics:

- No UI "Updated" column, ordering, revision tick, cursor or TTL sweep reads
  it. reports orders by `lastSeenAt` and ticks an in-process counter;
  saved_themes and agents order by `createdAt` / `rank`.
- Several tables never put it on the wire at all.
- One write site today bumps with no real change:
  `page/editor/server/internal/handle-move-block.ts:104-107` re-sets
  `expanded: true` on an already-expanded destination.

## Design

### 1. Declaration for raw tables: `deriveUpdatedAt` (derived-updated-at)

This is a new export of `@plugins/database/plugins/derived-updated-at/server`.
It wraps the table it declares, so the declaration sits next to the columns:

```ts
export const _agents = deriveUpdatedAt(
  pgTable("agents", { … }),
  { touchedBy: { name: true, prompt: true, …, id: false, createdAt: false } },
);
```

**Types**

- `touchedBy` is typed from the drizzle table:
  `{ [K in Exclude<keyof T["$inferSelect"], "updatedAt">]: TouchRule<T["$inferSelect"][K]> }`.
- It is total, and each transition is typed against its column's value, the
  same guarantees as `defineEntity`'s `TouchedBy`.
- A table without an `updatedAt` column is a type error.

**Runtime**

- It reads the physical column names and SQL types off `getTableColumns(table)`,
  calls `compileDerivedUpdatedAt`, then `registerDerivedUpdatedAt`, and returns
  the table unchanged.
- The same runtime totality check backs the types. Registration happens at
  module eval, which is the same moment `defineEntity` registers, so the boot
  installer (`database/server` `onReadyBlocking`) picks these tables up with no
  change.

**DRY**

- `defineEntity`'s `compileEntityUpdatedAt`
  (`infra/entities/server/internal/define-entity.ts`) already does exactly
  "drizzle table + touchedBy → spec".
- Move that column-reading half into derived-updated-at as
  `compileFromTable(table, touchedBy)`. Both `defineEntity` and
  `deriveUpdatedAt` call it, so there is one compiler path.
- Generalize the RAISE text in `compile.ts` from "declared in defineEntity's
  meta.updatedAt.touchedBy" to "declared by its touchedBy". Its test string
  changes.

### 2. Closing the set: check `derived-updated-at:declared`

This is a contributed check at `derived-updated-at/check/index.ts`, rung 3. It
follows the `schema-files-loadable` probe pattern
(`database/plugins/migrations/check/internal/`):

- A subprocess `require()`s every schema-glob file (`schemaGlobFiles` from
  `migrations/core`).
- It walks their exports for drizzle `PgTable`s (`is(x, PgTable)`) with a column
  named `updated_at`.
- It fails for any such table missing from `registeredDerivedUpdatedAt()`,
  naming the file and pointing at `deriveUpdatedAt` / `meta.updatedAt`.

**Why static and not a boot assert:** a boot scan of `information_schema` would
see the forked DB's full table set, but a composition namespace loads only a
subset of plugins, so the registry would legitimately be missing tables. The
schema globs are the complete, runtime-independent set of drizzle tables.

With this in place, a column named `updated_at` means "derived", with no
exceptions. A write-time or heartbeat stamp must be spelled differently (see
`live_state_snapshot`). Document this in the derived-updated-at CLAUDE.md.

### 3. Per-table adoption

Classification uses the same rule as the entities plan: a column counts when a
reader could see the change. Identity, FK owner and `createdAt` are `false`.
View state (`expanded`) is `false`, as agents already argue at
`handle-move.ts:77-80`: a collapse is not a fact about the record. Derived
denormalizations are `false`.

| table | `true` | `false` |
|---|---|---|
| active_data_bindings | payload | conversationId, messageId, tag, occurrenceIndex, createdAt |
| agents | parentId, name, prompt, model, icon, iconColor, iconSvgNodes, rank | id, createdAt |
| chord_curriculum | chords, blanks, modes | id |
| chord_index_state | phase, done, total, windows, error, snapshotName, scope, derivationVersion, skipped, startedAt, finishedAt | id |
| conversation_categories | item, source | id, conversationId, categoryId, createdAt |
| conversation_groups | title, rank | id, expanded, createdAt |
| data_view_custom_values | value | dataViewId, rowKey, columnId, createdAt |
| data_view_row_order | rank | dataViewId, viewId, rowKey, createdAt |
| deploy_deployments | compositionId, serverId, hostnames, loopbackPort | id, createdAt |
| deploy_servers | name, host, port, sshUser, consoleUrl, sshPublicKey | id, createdAt |
| page_block_docs | state | blockId |
| page_blocks | parentId, type, data, rank, deletedAt | id, pageId (derived from parentId), expanded, trashEntryId, createdAt |
| reports | kind, message, url, userAgent, data, count, rateLimited, noise, taskId | id, fingerprint, worktree, source, lastClientId, lastBuildId, firstSeenAt, lastSeenAt, createdAt |
| saved_themes | source, externalId, label, extends, fragments, colorAdjust | id, createdAt |

Special cases:

- **reports:** the upsert comment ("updated_at stays row-write time") is
  rewritten. `count: true` means every recurrence still moves it, which is
  visible in the list. Retention keys on `createdAt` and is unaffected.
- **conversation_categories:** the wire field `classifiedAt: t.updatedAt`
  (`resource.ts`, `shared/schemas.ts:19`) would silently become "last changed".
  It has no consumer, so rename it to `updatedAt` on the wire so the name stays
  honest.
- **chord_index_state:** `updated_at` has no DB default today (every insert
  supplies it). Add `.defaultNow()`, which is the one drizzle migration here,
  and drop it from the `beginIndexLoad` insert/conflict set.
- **live_state_snapshot:** this is hand-written DDL, not drizzle, and its column
  is a write-time stamp nobody reads. Rename it to `persisted_at` through the
  existing idempotent in-place upgrade in `tables-ddl.ts`, using
  `ALTER … RENAME COLUMN` guarded on `information_schema`, and update
  `persist.ts`. It is then correctly outside the rule.
- **improve_config:** never written and never read (only its barrel export and
  migration remain). **Drop the table** (migration) and its export, rather than
  declaring a dead row.

### 4. Delete the hand stamps

Remove every `updatedAt: new Date()`, `updatedAt: now` and
`updated_at = now()` on these tables.

Sites that seed a patch with `{ updatedAt }` must handle an empty patch. Drizzle
rejects an empty `set`, so skip the write and return the current row:

- `agents/handle-update.ts`
- `deploy/deployments/handle-update.ts`
- `deploy/servers/handle-update.ts`
- `page/editor/handle-update-block.ts`
- the patch-writer `updates` loop at `forest-writer.ts:1088-1099`

An upsert whose set would become empty keeps a PK self-rewrite, as the
extensions plan did.

Sites, by table:

- **active-data:** `routes.ts:15-39`.
- **agents:** `handle-update.ts`, `handle-move.ts:67-74`.
- **chord:** `curriculum/state.ts:31-57`; `song-index/state.ts` (`beginIndexLoad`
  and `updateState`).
- **conversation-category:** `store.ts:32-59`.
- **data-view:**
  - `custom-columns/handle-set-custom-column-value.ts`;
  - `view-order/handle-set-row-order.ts`. Its `setWhere` stays, because it
    suppresses the change-feed diff and not only the stamp.
- **deploy:**
  - `deployments/handle-update.ts`;
  - `servers/handle-update.ts`;
  - `servers/store-ssh-key.ts`. Its UPDATE still fires the change-feed.
- **page:**
  - `forest-writer.ts`: the `:797-812`, `:840-852` and `:1088-1099` update
    paths. Insert paths may keep their explicit value or drop it for the
    default.
  - `handle-update-block.ts`, `handle-move-block.ts:90-95`,
    `handle-turn-into-page.ts`, `trash-blocks.ts:378-390`,
    `page-row-write.ts:84` and `page-content.ts:236`.
  - The `recomputePageIdSubtree` raw SQL in `page-id.ts:111-140`.
  - `editor-collab/doc-store.ts:106`.
  - `handle-move-block.ts:104-107`: write `expanded: true` only when it is not
    already true, or rely on the trigger no longer bumping.
- **reports:** `record-report.ts:456-491`, `investigate.ts:95`.
- **saved-themes:** `store.ts` (`saveTheme`, `updateCustomTheme`, and the
  fold-children path).

Tests that UPDATE `updated_at` directly will now RAISE. `rg updatedAt` over
those plugins' `*.test.ts` and fix any fixture that writes it on UPDATE.
Inserts are fine.

### 5. Docs

- derived-updated-at CLAUDE.md: the `deriveUpdatedAt` API, the check, and the
  rule "`updated_at` means derived".
- entities CLAUDE.md: one line pointing raw tables at `deriveUpdatedAt`.
- The previous plan's §6: a pointer here.

## Tests

- `derived-updated-at/server/internal/`:
  - A unit test that `deriveUpdatedAt` on a stand-in `pgTable` compiles the same
    spec as the equivalent `defineEntity`.
  - `@ts-expect-error` for a missing column, a mistyped transition, and a table
    with no `updatedAt`.
- Extend `infra/entities/.../install-derived-updated-at.test.ts`, the real-DB
  suite, with one raw-table case: a counted change bumps, a no-op does not, and
  an `updated_at` write raises.
- A check test: a fixture schema file with an undeclared `updated_at` table
  fails.
- Run: `./equin test plugins/database/plugins/derived-updated-at plugins/infra/plugins/entities plugins/page plugins/reports plugins/apps/plugins/deploy plugins/apps/plugins/chord plugins/conversations/plugins/agents plugins/ui/plugins/theme-engine plugins/active-data plugins/primitives/plugins/data-view`.

## Verification

1. `./equin build` (background), then `./equin check`, including
   `derived-updated-at:declared` and `migrations-in-sync`.
2. `query_db`:
   - `pg_trigger` has `*_derive_updated_at` with a signature comment on all 14
     declared tables;
   - `improve_config` is gone;
   - `live_state_snapshot` has `persisted_at`.
3. In the worktree app:
   - Rename an agent: its `updated_at` moves. Collapse it: no move.
   - Edit a page block: it moves. Drag a block into an already-expanded parent:
     the parent does not move.
   - Re-save a saved theme unchanged: no move.
   - Trigger a repeat crash report: `count` and `updated_at` move.
4. Check the server log for `updated_at is derived … do not write it`, which
   would name a stamp that was missed.
