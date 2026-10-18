# `page_blocks` becomes an entity

Track: "DataView fields everywhere" (page `block-85963184-057d-4983-a5f0-c9183ae8d71c`), item [Entities] → `page_blocks`. Follows `research/2026-10-17-global-dataview-tables-become-entities.md` (Outcome: `page_blocks` deferred).

## Context

`page_blocks` is described twice: `pagesEntityRef` (`page/block-entity/core/internal/block-entity.ts`) states the wire record, and a raw `pgTable` (`page/editor/server/internal/tables.ts`, `_blocks = deriveUpdatedAt(pgTable(…))`) states storage. The server binds them by column name; nothing checks they agree, and they already disagree:

- `rank`: ref = `rankWireField()` (wire `Rank`), column = `rankText` (raw `string` key).
- `data`: ref = `jsonField<unknown>`, column = `parsedJson("data", StoredBlockDataSchema)` typed `BlockData` (brand minted only by `parseBlockData`).
- `docRank`, `deletedAt`, `trashEntryId`: columns with no field on the ref.

The sidebar DataView (`pages-sidebar.tsx`, over `pagesTree`) already derives its fields from the ref, so nothing changes for the user. The goal is exit criterion 2 of the track (no entity ref beside a raw `pgTable`): one declaration, no drift, and no exemption needed by the future [Guard] check.

## Findings that shape the plan

- **`defineEntity` already covers every table feature**, so no new building blocks are needed (`infra/entities/server/internal/define-entity.ts`, `types.ts`):
  - `meta.indexes(t)` is drizzle's 3rd `pgTable` arg and returns `AnyIndexBuilder | CheckBuilder`, so partial unique indexes (`.where(sql…)`, as `build_runs_inflight_uniq` does) and the `page_blocks_trash_flags_agree` CHECK both port verbatim. The ref's comment saying the CHECK "has no spelling" is stale.
  - Self-FK with cascade is spelled `columns.parentId.references: { column: (): AnyPgColumn => entity.table.id, onDelete: "cascade" }`, the way `agents` does it.
  - `meta.updatedAt.touchedBy` goes through the same `compileFromTable` as `deriveUpdatedAt`.
  - The 3-arg form `defineEntity(ref, serverFields, meta)` exists (`deploy_servers`).
  - The `rank` field's storage is `rankText`, the same DDL. The `json` storage is `parsedJson(name, field.schema)`, the same decoder when the field's schema is `StoredBlockDataSchema`.
- **`BlockData` is small, not ~65 files.** The brand, `asBlockData` and `StoredBlockDataSchema` live in `editor/core/schemas.ts:14-46` and depend only on `zod` plus the type-only `zod-parser/core`. About 5 files import them, all inside page/editor. The ~65 hits were the `Editor.BlockData` contribution, a different thing. `parseBlockData` (server) stays in the editor.
- **Rank split precedent:** tasks (`tasks-core/core/internal/fields.ts:59` uses `rankField()`, and `core/resources.ts:96` carries `rank: rankValueField()`) and agents. `rankWireField` is used only by block-entity and by `pagesTree`'s `docRank`.
- **Browser `.rank` / `.docRank` readers of `pagesTree` rows:** only `pages-sidebar.tsx:70` and `:285`, both of which read `docRank` as a `Rank`. Editor `Block.rank` comes from `BlockSchema` (`pageBlocks`), not from the ref.
- **`PageRow` is read-only in the browser.** It is parsed from `pagesTree` and the `GET` list endpoint (`handle-list-pages.ts`); the browser never builds one.

## Design

### 1. Move the `BlockData` brand into `page/block-entity/core`

- Move `BlockData` (brand), `asBlockData` and `StoredBlockDataSchema` from `editor/core/schemas.ts` to a new `block-entity/core/internal/block-data.ts`, exported from the block-entity core barrel. Keep the comments explaining that `parseBlockData` is the sole write-side minting site.
- Delete the `BlockData` re-export from `editor/core/index.ts`, because cross-plugin re-exports are banned. Update the ~5 importers (`page-row-write.ts`, `parse-block-data.ts` and its test, `stored-block-data.test.ts`, `tables.ts`) to `@plugins/page/plugins/block-entity/core`.
- block-entity stays a leaf that drizzle-kit can load: zod only, no Lexical or Yjs.

### 2. The ref states storage truth: `blockFields`

```ts
data: jsonField<BlockData>({ schema: StoredBlockDataSchema, default: asBlockData({}) }),
rank: rankField(),            // raw key; the wire Rank is the collection's (rankValueField)
```

- Delete `rankWireField`. Its role is `rankValueField()`, carried by the collection.
- Rewrite the file's header comment: the table is now `defineEntity(pagesEntityRef, …)`.
- `docRank`, `deletedAt` and `trashEntryId` stay **off** the ref as server fields (step 3). This departs from the earlier sketch, which put `docRank` on the ref:
  - `deletedAt` and `trashEntryId` are trash bookkeeping that no list shows, since the trash list reads `trash_entries`.
  - `docRank` is nullable in storage but carried non-null by `pagesTree` (invariant I-DR), so the collection declares its own wire form either way, exactly as today.
  - Keeping them server-only means a list cannot `pick` them by mistake.

### 3. The table: `editor/server/internal/tables.ts`

```ts
const blocksEntity = defineEntity(
  pagesEntityRef,
  {
    docRank: nullable(rankField()),
    deletedAt: nullable(dateField()),
    trashEntryId: nullable(textField()),
  },
  {
    primaryKey: "id",
    columns: {
      pageId:   { references: { column: (): AnyPgColumn => blocksEntity.table.id, onDelete: "cascade" } },
      parentId: { references: { column: (): AnyPgColumn => blocksEntity.table.id, onDelete: "cascade" } },
      expanded: { default: true },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: { touchedBy: { /* ported 1:1, incl. data: { exceptKeys: ["icon"] } and the 3 server fields: false */ } },
    indexes: (t) => [ /* the 5 indexes + check(...) verbatim */ ],
  },
);
export const _blocks = blocksEntity.table;
```

- Every existing comment (the rank-uniqueness story, soft delete, `docRank`, and so on) moves with its column or index.
- `data`'s default comes from the field (`default: asBlockData({})`). `jsonField` must apply it as the column default. Verify that the DDL stays `DEFAULT '{}'::jsonb`.
- **Type outcome:** `$inferSelect` keeps `rank: string`, `docRank: string | null` and `data: BlockData`. `BlockRow`, `NewBlockRow`, `forest-writer` and `page-rows` need no changes.

### 4. The collection: `editor/core/resources.ts` (`pagesTree`)

- Drop `"rank"` from `carry.pick`, and carry `rank: rankValueField()` and `docRank: rankValueField()`. The wire row is unchanged: both are `Rank`.
- `data` stays picked, so it now arrives as `BlockData` (a parsed JSON object). To keep `_PinPagesTreeRow` honest, narrow `PageRowSchema` to `BlockSchema.extend({ data: StoredBlockDataSchema, docRank, editedAt })`. `PageRow` is read-only, so a stricter read type is safe. `BlockSchema` (the editor's block, which the browser writes through ops) keeps `data: z.unknown()`, so the browser's write type does not change.
- `pages-tree-fields.test.ts` row keys stay the same.

### 5. Docs and track

- Regenerate the block-entity and editor `CLAUDE.md` / `REFERENCE.md` (the `rankWireField` and `BlockData` moves) through `./singularity build`.
- Add an Outcome note to this doc.
- On the track page: tick `page_blocks`, tick [Entities], update Status. Next step is [Lists].

## Risks to verify while implementing

1. **`touchedBy` typing:** `TouchedBy<F & SF>` must accept `{ exceptKeys }` for a `jsonField<BlockData>` field, and must require the 3 server fields.
2. **Table name literal:** `typeof blocksEntity.table` may widen the table name to `string`. Check that `live-blocks.ts`, `page-rows.ts` (`ServeAllCollectionOptions<typeof _blocks, …>`) and `links/link-source-rows.ts` still typecheck; the 15 earlier conversions did not hit this.
3. **Self-reference in a `const` initializer:** the thunk `blocksEntity.table.id` must be lazy (it is) and annotated `AnyPgColumn` (TS7022 otherwise), as `agents` does.
4. **No migration:** the build must generate nothing. If a diff appears (default spelling, index order, CHECK text), fix the declaration and never accept the migration.
5. **drizzle-kit load:** `tables.ts` → block-entity/core → zod only.

## Verification

- `./singularity build`: no new file under migrations, and checks green (`type-check`, `migrations-in-sync`, `change-feed:producer-writes`, `plugins-doc-in-sync`, boundary checks).
- `./singularity test plugins/page/plugins/editor plugins/page/plugins/block-entity plugins/page/plugins/editor-collab plugins/apps/plugins/pages`. The suites that matter most are the pages-tree oracle, `page-row-write`, `stored-block-data`, `parse-block-data`, `handle-patch-blocks`, and the `derived-updated-at` trigger behaviour on `page_blocks`.
- `query_db`: `\d page_blocks`-equivalent via `pg_indexes`, `pg_constraint` and the `information_schema.columns` defaults, compared against main's DB. They must be identical.
- E2E: `plugins/apps/plugins/pages/plugins/page-tree/e2e/page-tree-live-verify.ts` and a sidebar screenshot (create, reorder, trash and restore a page; edit a block, then check that Edited updates while an icon change does not).

## Outcome (2026-10-18)

Done as designed: `page_blocks` is `defineEntity(pagesEntityRef, { docRank, deletedAt, trashEntryId }, meta)`. The build generated **no migration**, and the live table matches main's DB exactly: a hash over its indexes, constraints, column types and defaults, and the `updated_at` trigger function's source is equal on both.

One departure: **`BlockData` is now a string-keyed brand** (`{ readonly __brand: "BlockData" }`, the form of `Namespace` and `PluginId`). The `unique symbol` key it had broke declaration emit once the brand moved to another plugin. `PageRowSchema` and `listPages` infer a type that spells the key, and TS cannot name a symbol from another plugin's module (TS4023), even when the barrel re-exports it type-only. The brand's job is unchanged: every write still goes through `parseBlockData`.

Risks 1 to 3 (the `touchedBy` typing with `exceptKeys` and the server fields, the table-name literal, the self-reference thunk) did not trip: type-check passes with no other change. `rankWireField` is deleted.
