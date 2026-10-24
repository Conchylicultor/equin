# Custom columns for any DataView

## Context

Today every `<DataView>` renders a **code-authored** `FieldDef[]` schema fixed at
the call site. A user cannot add their own column to attach ad-hoc metadata
(e.g. a "Notes" or "Priority" field on the tasks list). This is the first step
toward the project's composable-surface vision: the data schema becomes
user-extensible, not just developer-defined.

We add **user-defined custom columns** to the data-view primitive. v1 is
**text-only**, **on by default for every DataView** (with an opt-out), and managed
through a new **DataView Settings button → Fields submenu** in the toolbar. Because
custom columns become ordinary `FieldDef`s, they participate in the table
rendering, inline edit, sort, filter, and search pipelines **for free** on
in-memory views.

The mechanism is generic: every DataView already supplies the two coordinates a
metadata store needs — `storageKey: DataViewId` (per surface) and
`rowKey(row) => string` (per row). Custom values are keyed by
`(dataViewId, rowKey, columnId)`, so this works for any DataView regardless of its
backing data source.

## Decisions (locked with the user)

- **On by default, opt-out per surface** via a `customColumns?: boolean` prop.
- **Text-only in v1.** Architected so number/date/checkbox are small follow-ups
  (the field `type` is registry-driven, never hardcoded past the "add column" menu).
- **UI**: a new gear/settings `IconButton` in the toolbar (separate from the
  per-view-instance `ViewSettingsPopover`), opening a popover with a **Fields**
  section to add / rename / delete columns.

## Design overview — two stores

| Store | What | Where | Why |
|---|---|---|---|
| **Column definitions** | per-surface schema `{ id, label, type }[]` | **config_v2** `extraFields` injected into `viewsDescriptor` | git-promotable, per-app-scopable, reactive via `useConfig`, **zero new registration machinery** — identical to the proven `sortPresetsExtraFields` |
| **Column values** | per-row user data keyed by `(dataViewId, rowKey, columnId)` | **new DB table** + live resource, owned by a new sub-plugin | genuine per-row data; needs live reactivity and could grow |

A **bridge hook** composes both into `FieldDef[]` and the **host appends them** to
`props.fields`, so they flow into every view + sort/filter/search.

## New sub-plugin

`plugins/primitives/plugins/data-view/plugins/custom-columns/` — `core/`, `web/`,
`server/` (no `shared/`: all shared code is framework-agnostic and lives in `core/`).
Auto-discovered by the loader like `view-core`/`table` (run `./equin build`).

Cycle direction: **data-view (parent) → custom-columns (child)** is the legal
direction (same as data-view already importing `view-core`). custom-columns must
**never import data-view or view-core** — it imports only `config_v2`, `fields`,
`live-state`, `endpoints`. The host threads the resolved config descriptor down
(see Host integration), so the child stays free of any data-view import.

### `core/` (pure, isomorphic)

- `core/internal/extra-fields.ts` → `customColumnsExtraFields: FieldsRecord`
  (mirrors `data-view/shared/sort-presets-field.ts`):
  ```ts
  export const customColumnsExtraFields: FieldsRecord = {
    customColumns: listField({
      label: "Custom columns",
      itemFields: {
        id: textField({ label: "Id" }),       // stable join key to the values table
        label: textField({ label: "Label" }),
        type: textField({ label: "Type", default: "text" }),
      },
    }),
  };
  ```
  Imports `listField`/`textField` from `@plugins/fields/plugins/{list,text}/plugins/config/core` (pure, server-safe).
- `core/internal/types.ts` → `CustomColumnDef` (`{ id; label; type }`),
  `CustomColumnValueRow` (`{ rowKey; columnId; value }`) + zod schemas.
- `core/internal/resource.ts` → `customColumnValuesResource` (live-state descriptor, keyed `{ dataViewId }`).
- `core/internal/endpoints.ts` → `setCustomColumnValue` (`defineEndpoint`).
- `core/index.ts` re-exports the above.

### `server/`

- `server/internal/tables.ts`:
  ```ts
  export const _dataViewCustomValues = pgTable("data_view_custom_values", {
    dataViewId: text("data_view_id").notNull(),
    rowKey: text("row_key").notNull(),
    columnId: text("column_id").notNull(),
    value: text("value").notNull(),                 // v1 text; widen to jsonb later via migration
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  }, (t) => [
    primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] }),
    index("dvcv_data_view_id_idx").on(t.dataViewId),
  ]);
  ```
- `server/internal/resource.ts` → `customColumnValuesLiveResource` —
  `defineResource({ mode: "push", key: customColumnValuesResource.key, loader: ({ dataViewId }) => db.select({rowKey,columnId,value}).from(_dataViewCustomValues).where(eq(dataViewId))})`.
  Clone of `blocksLiveResource` in `plugins/page/plugins/editor/server/internal/resources.ts`.
  **No special change-feed wiring**: a `mode:"push"` param resource recomputes
  automatically when `_dataViewCustomValues` is written (change-feed read-set match).
  No `dependsOn`, no `identityTable`, no `ExcludeFromChangeFeed`.
- `server/internal/handle-set-custom-column-value.ts` — `value === ""` → `DELETE`
  by PK; else `insert(...).onConflictDoUpdate({ target: pk cols, set: { value, updatedAt } })`.
- `server/index.ts` — `httpRoutes` for `setCustomColumnValue`, `contributions: [Resource.Declare(customColumnValuesLiveResource)]`, re-export `_dataViewCustomValues`.

### `web/`

- `web/internal/use-custom-column-values.ts` → `useCustomColumnValues(storageKey)`:
  `useResource(customColumnValuesResource, { dataViewId: storageKey })`, `useMemo`
  to index into `Map<rowKey, Map<columnId, string>>`. Plus `useSetCustomColumnValue()` =
  `useEndpointMutation(setCustomColumnValue)`.
- `web/internal/use-custom-column-defs.ts` → `useCustomColumnDefs(descriptor)`:
  clone of `useSortPresets` (`data-view/web/internal/use-sort-presets.ts`) — takes
  the **resolved `ConfigDescriptor`** (threaded from the host), `useConfig` +
  `useSetConfig`, optimistic mirror with JSON-guarded reconcile. Returns
  `{ defs, addColumn(label), renameColumn(id,label), deleteColumn(id) }`; each
  writes the `customColumns` key. New ids are `cc-<rand>` (no collision with
  consumer field ids).
- `web/internal/use-custom-column-fields.ts` → the **bridge**:
  ```ts
  function useCustomColumnFields<TRow>(opts: {
    storageKey: DataViewId; rowKey: (r: TRow, i: number) => string; defs: CustomColumnDef[];
  }): FieldDef<TRow>[]
  ```
  Reads values, captures `rowKey` via `useLatestRef` (decouple from the consumer's
  inline-arrow identity), and maps each def to a `FieldDef` whose
  `value(row) = values.get(rowKey(row,0))?.get(def.id) ?? ""`,
  `onEdit(row,next) = setValue({ dataViewId: storageKey, rowKey: rowKey(row,0), columnId: def.id, value: String(next ?? "") })`,
  `type: def.type` (NOT a literal — the extension seam), `sortable: true, filterable: true`.
  Text columns get read cell + click-to-edit + filter for free from the already
  registered `fields/text/{table,inline,filter}` contributions.
- `web/components/data-view-settings-button.tsx` → `DataViewSettingsButton`:
  `IconButton` (icon `MdTune`) inside `InlinePopover`; body is a `SectionLabel`
  "Fields" + one row per def (`Input` label, blur/Enter → `renameColumn`; delete
  `IconButton`) + an "Add column" input/button → `addColumn`. Primitives:
  `icon-button`, `popover`, `css/ui-kit` (`Button`,`Input`), `css/text`.

## Definitions merge (the one wiring change in data-view)

Both call sites currently pass `sortPresetsExtraFields` directly. **Merge, don't
replace** (keys are disjoint; build one identity-stable module constant per runtime
because the `viewsDescriptor` cache keys by id alone):

- `data-view/web/internal/descriptors.ts`:
  ```ts
  import { customColumnsExtraFields } from "@plugins/primitives/plugins/data-view/plugins/custom-columns/core";
  const extraFields = { ...sortPresetsExtraFields, ...customColumnsExtraFields };
  const { map, entries } = buildViewDescriptors(dataViews.map((v) => v.id), extraFields);
  ```
- `data-view/server/internal/config-registrations.ts`: identical merge, then
  `buildViewConfigRegistrations(dataViews.map(...), extraFields)`.

No `view-core` change — both helpers already accept `extraFields` unchanged.

## Host integration (`data-view/web/components/data-view.tsx`)

In `DataViewInner`, resolve the descriptor (already available via
`dataViewDescriptors.get(props.storageKey)`), then before the sort/filter controllers:

```ts
const descriptor = dataViewDescriptors.get(props.storageKey);
const enabled = props.customColumns !== false && descriptor != null;
const { defs, ...colActions } = useCustomColumnDefs(descriptor);          // called unconditionally
const customFields = useCustomColumnFields({ storageKey: props.storageKey, rowKey: props.rowKey, defs: enabled ? defs : [] });
const fields = useMemo(
  () => (enabled ? [...props.fields, ...customFields] : props.fields),
  [enabled, props.fields, customFields],
);
```

`fields` already feeds `useFilterController`, `useSortController`, and
`renderProps.fields`, so custom columns reach every view + sort + filter + search
with no per-view changes. Hooks run unconditionally (hook rules); when opted out
they read an empty defs list — one cached config read + one WS observe per
DataView, negligible (documented trade, not gated).

Toolbar: render `<DataViewSettingsButton defs={defs} actions={colActions} />`
inside the `<Sticky>` immediately before `<EditableViewSwitcher>`, gated by
`enabled`.

## Opt-out prop (`data-view/core/internal/types.ts`)

```ts
/** User-defined custom columns (text, v1) are ON by default for every DataView.
 *  Set false on surfaces where ad-hoc metadata doesn't belong (debug/metric/config
 *  tables, or index-derived rowKeys). Mechanism is generic — keyed by storageKey + rowKey. */
customColumns?: boolean;
```
Field on the already-exported `DataViewProps` — no barrel change.

## Edge cases (documented, not solved in v1)

- **`rowKey` must be index-independent**: the bridge calls `rowKey(row, 0)`
  (`FieldDef.value` gets no index). True for all id-based consumers; surfaces with
  index-derived keys should set `customColumns={false}`.
- **`rowKey` stability**: values orphan if a logical row's `rowKey` changes.
- **Server-delegated (`dataSource`) views**: custom columns render + edit, but do
  **not** participate in server-side sort/filter/pagination (host neutralizes the
  client pipeline; SQL doesn't know these columns). v1 limitation.
- **Deleting a column** leaves its value rows orphaned (harmless/unreachable).
  Optional follow-up: cascade-delete endpoint.
- **`data-view:configs-authored` check**: unaffected — `customColumns` is a sibling
  key in the existing per-surface config doc; runtime adds land in the user-global layer.

## Critical files

- `plugins/primitives/plugins/data-view/plugins/custom-columns/**` (new)
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` (host merge + toolbar button)
- `plugins/primitives/plugins/data-view/web/internal/descriptors.ts` (extraFields merge)
- `plugins/primitives/plugins/data-view/server/internal/config-registrations.ts` (extraFields merge)
- `plugins/primitives/plugins/data-view/core/internal/types.ts` (`customColumns` prop)
- Templates to clone: `data-view/web/internal/use-sort-presets.ts` (defs controller),
  `data-view/shared/sort-presets-field.ts` (extra-fields shape),
  `plugins/page/plugins/editor/server/internal/resources.ts` (live resource).

## Verification

1. `./equin build` — generates the `data_view_custom_values` migration
   (table glob auto-discovers `server/internal/tables.ts`), registers the resource +
   route, runs checks (`table-defs-in-schema-glob`, `orphaned-tables`, typecheck/lint;
   `data-view:configs-authored` unaffected).
2. End-to-end on the **tasks list** DataView:
   - Gear → Fields → "Add column" "Notes" → a new text column appears.
   - Click a row's Notes cell → type → blur/Enter → upsert fires, resource ticks.
   - **Reload** → value persists.
   - Sort by Notes → rows reorder (client-side sort on the appended FieldDef).
   - Filter on Notes → works (text filter contributions).
   - Rename → header updates; Delete → column disappears.
3. Confirm a surface with `customColumns={false}` shows no gear and no extra column.

## Follow-ups (out of scope)

- More field types (number/date/checkbox/select) — add `type` choices to the Fields
  submenu; cells/editors/filters resolve from the existing `fields/<type>` slots.
- Per-view-instance column visibility/order.
- Cascade-delete of orphaned values on column delete.
- Server-side participation for `dataSource` views.
