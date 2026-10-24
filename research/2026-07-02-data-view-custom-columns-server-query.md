# Custom DataView columns: server-side sort/filter/keyset

**Date:** 2026-07-02
**Status:** Plan — approved for scope (generic seam) + surface-id delivery (thread through request)

## Context

Custom columns (`data-view/plugins/custom-columns`) are a purely **client-side**
field extension: they contribute `FieldDef`s (with `sortable: true`,
`filterable: true`) into every DataView via the global
`DataViewSlots.FieldExtension` slot, and persist per-row values in a separate
generic DB table `data_view_custom_values` keyed by
`(data_view_id, row_key, column_id)`.

On an **in-memory** DataView this is enough: the merged `FieldDef[]` schema drives
client-side sort/filter, so custom columns just work. On a **server-delegated**
DataView (the `dataSource` path — e.g. the All-conversations table), sort/filter/
keyset are compiled to SQL by `data-view/plugins/server-query` against a
`FieldColumnMap` the consumer builds from its **base table columns only**. Custom
column values live in `data_view_custom_values`, which is never joined into the
query, so:

- The web **already sends** `sort`/`filter` rules referencing custom-column field
  ids (`cc-*`) — the custom fields are folded in *before* the sort/filter
  controllers.
- The server's `compileWhere` / `buildSortKeys` **fail-soft drop** any field not in
  the `FieldColumnMap` (custom `cc-*` ids are unmapped), so sorting or filtering by
  a custom column **silently does nothing**.

**Goal:** make custom columns participate in server-side sort, filter, and keyset
pagination, via a **reusable server-side extension seam** — the server twin of the
web global `FieldExtension` slot — so every current and future server-delegated
DataView gets it for free, with the consumer never naming `custom-columns`.

## Implementation note (deviation from plan)

The `QueryAugmentor` seam was planned to live in **`data-view/server`** (for symmetry
with the web `FieldExtension` slot). That created a boundary **cycle**:
`data-view/server → server-query` (importing `FieldColumnMap`) while
`server-query → data-view/core` (compiler importing filter/sort types) already
existed. Since the augmentation *produces* a `FieldColumnMap` (a server-query
concept), its true home is **`server-query/server`** — that's where it landed. The
seam owns `DataViewServer.QueryAugmentor` + `augmentServerQuery`; `data-view/server`
keeps only a `readDataViewConfigDoc(dataViewId)` helper (its legitimate config
concern), which `augmentServerQuery` calls. Everything else matches the plan below.

## Approach

Mirror the existing web architecture on the server:

- **Web today:** `data-view` owns the global `DataViewSlots.FieldExtension` slot;
  `custom-columns` contributes itself; the host folds it in. Consumers name no
  contributor.
- **Server (new):** `data-view/server` owns a generic **`QueryAugmentor`** server-
  contribution registry; `custom-columns/server` contributes an augmentor that
  `LEFT JOIN`s `data_view_custom_values` per referenced custom column and returns
  `FieldColumnMap` bindings + join thunks + projection; the consumer calls one
  generic `augmentServerQuery(...)` and merges the result into its query. Consumers
  name no contributor.

`server-query` stays a **pure compiler** — unchanged. Its `ColumnBinding.col` is
typed `AnyColumn`, and a drizzle `alias()`-joined column *is* an `AnyColumn`, so the
custom join columns drop straight into the existing `FieldColumnMap` /
`compileWhere` / `buildSortKeys` / `orderByClauses` / `seekPredicate` machinery with
**no changes to server-query**.

### Data flow

1. Web `useServerDataSource` injects `dataViewId = storageKey` into the
   `fetchPage` args (new generic seam).
2. Consumer endpoint body carries `dataViewId`; handler passes it to
   `augmentServerQuery({ dataViewId, rowKeyCol, sort, filter })`.
3. `augmentServerQuery` (in `data-view/server`) reads the surface's config doc
   once (to learn which `cc-*` ids exist + their types), then folds every
   registered `QueryAugmentor`, passing the parsed config + context.
4. `custom-columns`' augmentor: for each custom column referenced by `sort`/
   `filter`, build a `LEFT JOIN data_view_custom_values <alias> ON alias.data_view_id
   = :id AND alias.column_id = :colId AND alias.row_key = <rowKeyCol>::text`, bind
   `alias.value` into the `FieldColumnMap` under the `cc-*` id (type = the def's
   type, `"text"` in v1, `nullable: true`), and (for sort-key columns only) add
   `alias.value` to the projection so `keyValuesOf` can mint the cursor.
5. Consumer merges `aug.columnMap` into its base `COLUMN_MAP`, applies
   `aug.joins` to a `$dynamic()` query, adds `aug.projection`, and runs the
   existing pipeline unchanged.

Because a custom column bound to type `"text"` resolves through the existing
`resolveFieldFilterSql("text", op)` registry, **filter operator SQL needs no new
code**. Sort works via `orderByClauses`. Keyset stays strict (the PK tiebreaker is
untouched).

## Changes

### 1. `data-view/server` — the generic seam (new)

Files: `plugins/primitives/plugins/data-view/server/` (new `internal/` files +
barrel additions).

- Define a server-contribution token, mirroring `Fields.FilterSql`
  (`plugins/fields/plugins/server-capabilities/server/internal/filter-sql.ts` is
  the reference pattern — `defineServerContribution` from
  `@plugins/framework/plugins/server-core/core`):

  ```ts
  export interface QueryAugmentorContext {
    dataViewId: string;
    rowKeyCol: AnyColumn;           // the column whose value == web rowKey(row)
    sort: SortRule[];
    filter: FilterGroup | null;
    config: Record<string, unknown>; // parsed config doc for this surface (opaque)
  }
  export interface DataViewJoin { apply: <Q extends PgSelect>(q: Q) => Q; }
  export interface ServerQueryAugmentation {
    columnMap: FieldColumnMap;               // cc-id -> ColumnBinding (aliased col)
    joins: DataViewJoin[];
    projection: Record<string, AnyColumn>;   // cc-id -> aliased col (sort keys only)
  }
  export type QueryAugmentor =
    (ctx: QueryAugmentorContext) => ServerQueryAugmentation | Promise<ServerQueryAugmentation>;

  export const DataViewServer = { QueryAugmentor: <token> };
  ```

- Build a **server-side descriptor map** (mirror
  `web/internal/descriptors.ts`) so config can be read by `dataViewId`. Reuse the
  existing `dataViews` manifest + `extraFields` already assembled in
  `server/internal/config-registrations.ts` (which already spreads
  `customColumnsExtraFields`). This gives `getConfig(descriptor)` →
  `{ views, sortPresets, filterPresets, customColumns }`.

- Export the generic collector:

  ```ts
  export async function augmentServerQuery(
    ctx: Omit<QueryAugmentorContext, "config">,
  ): Promise<ServerQueryAugmentation> {
    const augmentors = DataViewServer.QueryAugmentor.getContributions();
    if (augmentors.length === 0) return EMPTY;
    const config = await getConfig(descriptorFor(ctx.dataViewId)); // config_v2/server
    const results = await Promise.all(augmentors.map((a) => a({ ...ctx, config })));
    return mergeAugmentations(results); // merge columnMap / joins / projection
  }
  ```

  `data-view/server` imports `server-query/server` (for `FieldColumnMap` /
  `ColumnBinding` types — a clean parent→child edge; `server-query` imports nothing
  back) and `config_v2/server` `getConfig` (existing pattern; `conversations` already
  uses it). It does **not** import `custom-columns`.

- Register the token in `server/index.ts`'s `contributions` alongside the existing
  `dataViewConfigRegistrations`. Keep the barrel loop-free (build arrays in
  `internal/`, per barrel-purity).

### 2. `custom-columns/server` — the augmentor contributor

Files: `plugins/primitives/plugins/data-view/plugins/custom-columns/server/`.

- Move the defs normalizer `readCustomColumnDefs`
  (`web/internal/read-custom-column-defs.ts`) to **`shared/`** (plugin-private,
  web+server) so both runtimes use one normalizer. (`CustomColumnDef` type is
  already in `core/internal/types.ts`.)

- Add `server/internal/query-augmentor.ts` contributing `DataViewServer.QueryAugmentor`:
  - `const defs = readCustomColumnDefs(ctx.config.customColumns)` → the custom
    column id set + types.
  - `referenced = new Set(fieldIds in ctx.sort ∪ leaves of ctx.filter)`.
  - For each `def` whose `id ∈ referenced`:
    - `const t = alias(_dataViewCustomValues, sanitize("dvcv_" + def.id))`
      (drizzle `alias` from `drizzle-orm/pg-core`; sanitize `cc-...` hyphens).
    - join thunk: `q.leftJoin(t, and(eq(t.dataViewId, ctx.dataViewId),
      eq(t.columnId, def.id), eq(t.rowKey, sql`${ctx.rowKeyCol}::text`)))`.
    - `columnMap[def.id] = { col: t.value, type: def.type /* "text" */, nullable: true }`.
    - if `def.id` appears in `ctx.sort`: `projection[def.id] = t.value`.
  - Return `{ columnMap, joins, projection }`.
- `custom-columns/server` already owns `_dataViewCustomValues`
  (`server/internal/tables.ts`); it imports `server-query/server` for the binding
  types (sibling edge) and `data-view/server` for the token (child→parent edge).

### 3. Web seam — inject `dataViewId` into `fetchPage` args

Files: `data-view/core/internal/types.ts`,
`data-view/web/internal/use-server-data-source.ts`, and the `<DataView>` host that
calls `useServerDataSource`.

- Extend the `ServerDataSourceSpec.fetchPage` **args type** with `dataViewId: string`.
- `useServerDataSource(view, spec, storageKey)` — thread the host's `storageKey` in
  and inject `dataViewId: storageKey` into the object passed to `spec.fetchPage`
  (lines 78–84). The consumer's `fetchPage` closure (which spreads args into the
  request body) then carries it with no change.

### 4. Consumer wiring — `all-conversations`

Files:
- `core/internal/endpoints.ts` — add `dataViewId: z.string()` to
  `QueryConversationsBodySchema`.
- `server/internal/handle-query.ts`:

  ```ts
  const aug = await augmentServerQuery({
    dataViewId: body.dataViewId, rowKeyCol: conversations.id, sort, filter,
  });
  const columnMap = { ...COLUMN_MAP, ...aug.columnMap };
  const keys = buildSortKeys(sort, columnMap, { col: conversations.id, fieldId: "id" });
  // ...seek/where use columnMap...
  let q = db
    .select({ ...getTableColumns(conversations), ...aug.projection })
    .from(conversations)
    .$dynamic();
  for (const j of aug.joins) q = j.apply(q);
  const rows = await q.where(where).orderBy(...orderByClauses(keys)).limit(limit + 1);
  ```

- **Strip custom projection keys from `items`** before returning (compute the
  cursor from the raw row first, then omit `Object.keys(aug.projection)`), because
  `ConversationSchema` is entity-derived (**strict** `z.object`, per
  `fields/core` `fieldsToZodObject`) and would reject unknown `cc-*` keys.
  `keyValuesOf(lastRawRow, keys)` still reads the custom value for the cursor.

- The web `fetchPage` closure needs **no change** — it already spreads `args` into
  the body, and `args` now includes `dataViewId`. `dataViewId` on the
  All-conversations DataView is its `storageKey` (`ALL_CONVERSATIONS_VIEW`).

The two other consumers of this endpoint (`conversations-view/data-view/history`
and `.../queue`) reuse the same web `fetchPage`, so they inherit the fix with no
change — they just pass their own `storageKey` as `dataViewId`.

## Critical files

| Concern | Path |
|---|---|
| server-query compiler (unchanged, reference) | `plugins/primitives/plugins/data-view/plugins/server-query/server/internal/compile.ts` |
| server-contribution token pattern (reference) | `plugins/fields/plugins/server-capabilities/server/internal/filter-sql.ts` |
| data-view server barrel + config registrations | `plugins/primitives/plugins/data-view/server/index.ts`, `.../server/internal/config-registrations.ts` |
| web server-datasource hook | `plugins/primitives/plugins/data-view/web/internal/use-server-data-source.ts` |
| ServerDataSourceSpec type | `plugins/primitives/plugins/data-view/core/internal/types.ts` (~517–545) |
| custom-columns values table | `.../custom-columns/server/internal/tables.ts` |
| custom-columns defs normalizer (move to shared/) | `.../custom-columns/web/internal/read-custom-column-defs.ts` |
| consumer handler | `plugins/conversations/plugins/all-conversations/server/internal/handle-query.ts` |
| consumer column map | `.../all-conversations/server/internal/column-map.ts` |
| consumer endpoint body schema | `.../all-conversations/core/internal/endpoints.ts` |
| consumer web dataSource wiring | `.../all-conversations/web/panes.tsx` |

## Reused, not rebuilt

- `server-query`: `buildSortKeys`, `compileWhere`, `orderByClauses`,
  `seekPredicate`, `keyValuesOf` — untouched; custom columns flow through as normal
  `FieldColumnMap` entries.
- `resolveFieldFilterSql("text", op)` — existing text operator SQL, reused for
  custom columns.
- `defineServerContribution` (`framework/server-core/core`) — the registry
  primitive, per the `Fields.FilterSql` precedent.
- `config_v2/server` `getConfig` — read the surface config (already declares
  `customColumns` opaquely via `customColumnsExtraFields`).
- `drizzle-orm/pg-core` `alias` + `getTableColumns` — dynamic joins + flat
  projection.

## Verification

1. `./equin build` (regenerates registries; runs `plugin-boundaries` +
   `type-check` + `data-view:*` checks — confirm no boundary/cycle violations from
   the new `custom-columns/server → data-view/server` and `data-view/server →
   server-query/server` edges).
2. Open `http://<worktree>.localhost:9000` → All-conversations table. Via the
   settings **Fields** control, add a text custom column; type distinct values into
   a few rows.
3. **Sort:** pick the custom column in the Sort pill → rows reorder by the custom
   value; scroll to trigger keyset pagination → **no dup/skipped rows** across page
   seams (the tiebreaker + NULLS-LAST seek stays strict; rows with an empty custom
   value sort last).
4. **Filter:** add a Filter rule on the custom column (`contains` / `is`) → the
   window narrows to matching rows; paginates correctly.
5. **Regression:** sort/filter on a **base** column still works (custom augmentor
   must not bind or join base fields — it only touches ids present in
   `config.customColumns`).
6. Confirm the response still validates: `items` carry only base `Conversation`
   fields (custom projection keys stripped) — no strict-schema parse error. Use
   `query_db` to eyeball `data_view_custom_values` and, if needed, the emitted SQL
   (log the compiled query) to confirm the `LEFT JOIN … row_key = id::text` shape.
7. Drive it with `bun e2e/screenshot.mjs` clicking the Sort/Filter controls to
   capture before/after and confirm row order/state actually changes.

## Notes / caveats to surface

- **Row-key coupling:** the join matches `data_view_custom_values.row_key` against
  `rowKeyCol::text`. This is correct only when the consumer's web `rowKey(row)`
  equals the value of the `rowKeyCol` it passes (true for All-conversations:
  `rowKey = c.id`, `rowKeyCol = conversations.id`). Document this invariant on
  `augmentServerQuery`; a mismatch yields all-NULL custom values (fail-soft, not a
  crash).
- **Perf:** one `LEFT JOIN` per *referenced* custom column, supported by the
  `data_view_custom_values` PK `(data_view_id, row_key, column_id)`. Only columns
  in the active sort/filter are joined — unused custom columns cost nothing.
- **v1 is text-only:** `def.type` is always `"text"`, so operator SQL is always
  resolvable. When custom columns gain typed values (the table's `value` widens to
  `jsonb`), the augmentor already binds `def.type`, so typed operator SQL flows
  through `resolveFieldFilterSql(def.type, op)` with no further change here.
