# custom-columns

User-defined custom columns for any DataView. Two stores:

- **Definitions** (per-surface schema `{ id, label, type }[]`) live in **config_v2**
  under the `customColumns` key. The declaration (`customColumnsExtraFields`) lives
  in **data-view's `shared/custom-columns-field.ts`** (next to `sort-presets-field`),
  merged by the host into view-core's `viewsDescriptor` next to `sortPresets` — it
  must live on the host because a config_v2 write requires the field be declared on
  the descriptor, and the descriptor is data-view's. The field is **opaque storage
  owned by this sub-plugin**: data-view never reads its shape; custom-columns owns
  the `CustomColumnDef` type + `readCustomColumnDefs` normalizer. Git-promotable,
  per-app-scopable, reactive — zero new registration machinery (mirrors
  `sortPresetsExtraFields`).
- **Values** (per-row user data keyed by `(dataViewId, rowKey, columnId)`) live in
  the `data_view_custom_values` DB table, surfaced by the `customColumnValues` live
  value (`liveValue` with `params: ["dataViewId"]`, served
  `serveValue(…, { source: "db", unbounded })` — recomputed by the change feed on
  every write) + a single upsert/delete-on-empty endpoint. A value, not a
  collection: the composite key has no single id to read a row by.
  `useCustomColumnValues` is a `ResourceResult`. While it is `loading` the cells
  read as unset — dropping the columns would turn a filter on one into
  keep-every-row. A failed read keeps its `stale` values; with none, every custom
  field carries `FieldDef.readError`, so `FieldCell` renders the failure (with
  Retry) in each cell instead of an unset-looking value.

**Dependency direction: this child imports the parent (`custom-columns → data-view`),
never the reverse.** It contributes itself both ways instead of the host reaching
down:

A column's opaque `config` blob stays opaque here: the minted `FieldDef` spreads
`useResolveColumnDerive()(def.type, def.config)` first, letting the field type
publish the **generic** keys its config implies (enum's options → `FieldDef.options`)
before the identity/storage keys are applied on top. Consumers therefore read one
contract and never crack open `config`.

- **Per-row `FieldDef[]`** via the **global `DataViewSlots.FieldExtension` slot**
  (`custom-column-field-extension.tsx`). The host folds every DataView's
  contributions into the schema (before the sort/filter controllers), threading
  `{ storageKey, rowKey }` so this contributor keys its per-row `value`/`onEdit`.
  This is the old host-owned `useCustomColumnFields` bridge, moved here.
- **The "Fields" UI** via `DataViewSlots.Setting({ scope: "global" })`
  (`custom-columns-setting.tsx`). It reads `storageKey` from `useDataViewControls()`
  and resolves the SAME reference-stable descriptor the host registered via
  `getDataViewDescriptor(storageKey)` (config match is by `===`). The setting is one
  `ControlPanel.Section` — a row per column plus `New field` — and editing or
  creating one opens a **pushed page**. Those pages re-resolve the descriptor and
  the defs controller themselves rather than capturing them: a panel-stack entry's
  `render` closure is captured when the row is clicked, so a `def` passed in would
  still be the pre-rename one after the page's own rename.

Both resolve the descriptor through the host's exported `getDataViewDescriptor`;
the host names neither contributor (full collection-consumer separation). The
`useCustomColumnDefs(descriptor)` controller still takes the resolved descriptor as
an argument (not resolved off `dataViewDescriptors`), so it stays independent of
how the caller obtained it.

## Sort and filter on the server

- **A live source** (research/2026-09-29-global-scoped-change-routing.md P3):
  custom columns are the `custom` SCOPED column set (`server/internal/scoped-columns.ts`,
  a `LiveColumns.Scoped` contribution). Every collection declaring a `columnScope`
  — the DataView surface it is listed on — sorts and filters by that surface's
  columns under their wire names `custom.<column id>`: a tuple joins
  `data_view_custom_values` once per column it names (a join FAMILY, one route: an
  alias on `row_key`, kept to the surface's rows, matched per tuple on the columns
  it reads), each value read through its type's cast (`resolveFieldValueTextCast`,
  whose `sqlType` a scroll cut casts back through). The members are the surface's
  definitions as its config says NOW (read at request time). The field extension,
  handed `liveColumnScope`, binds each filterable or sortable column
  (`scopedLiveColumns(scope, CUSTOM_COLUMNS_SET, …).column(id)`), declared in the
  domain its operator set lowers over; the server decodes a query strictly
  against ITS definitions. Values still DISPLAY from `customColumnValues`; only a
  sort or filter joins a column.
- **The definitions move the SQL**: `customColumnDefs` (`data-view-custom-column-defs`,
  params `dataViewId`) is an external value served from the config and notified
  from a config watch (`watchScopedDefinitions`, in `onReady`, one watch per scope
  the set was bound under — `customScopedColumns.scopes()`, recorded by each
  collection's fold, so a collection serving the set cannot go unwatched; a write
  that moved only the view state compares equal and notifies nothing). Each scoped collection's window `recomputeOn`s it,
  so a column added, dropped or retyped recomputes its live tuples FULL once.
- `e2e/` publishes `defineCustomColumns` / `setCustomColumnCell` /
  `clearCustomColumnValues` / `setSurfaceConfig` for scripts driving a surface's
  columns through the app's API (config writes are put back by the harness's
  agent-write ledger).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: User-defined custom columns for any DataView: the config-backed definition controller, the per-row values live hook + upsert mutation, and the toolbar settings (Fields) button. Persists per-row custom-column values keyed by (dataViewId, rowKey, columnId): a generic DB table, a push live resource, and an upsert/delete-on-empty endpoint.
- Web:
  - Contributes:
    - `IdKinds.Kind` "cc"
    - `DataViewSlots.FieldExtension` "custom-columns" → `CustomColumnFieldExtension`
    - `DataViewSlots.Setting` "custom-columns" → `CustomColumnsFieldsSetting`
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×9
    - `primitives/live-state` ×3
    - `config_v2` ×2
    - `primitives/css/control-panel` ×2
    - `ids.IdKinds`
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLive`
    - `primitives/css/ui-kit.Input`
    - `primitives/latest-ref.useLatestRef`
    - `ui/icons.Icon`
  - Exports (types):
    - `CustomColumnDefsController`
    - `CustomColumnValueIndex`
    - `CustomColumnValues`
  - Exports (values):
    - `CustomColumnsFields`
    - `useCustomColumnDefs`
    - `useCustomColumnValues`
    - `useSetCustomColumnValue`
- Server:
  - Contributes:
    - `ids.kind` "cc"
    - `resource.declare` "data-view-custom-column-defs"
    - `resource.declare` "data-view-custom-values"
    - `live.columns.scoped` "custom"
  - Uses:
    - `database.db`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `fields/server-capabilities.resolveFieldValueTextCast`
    - `ids.IdKinds`
    - `infra/endpoints.implement`
    - `network/live.LiveColumns`
    - `network/live.ScopedMemberRead`
    - `network/live.serveScopedColumns`
    - `network/live.serveValue`
    - `primitives/data-view.readDataViewConfigDoc`
    - `primitives/data-view.watchDataViewConfigDoc`
  - DB schema: `plugins/primitives/plugins/data-view/plugins/custom-columns/server/internal/tables.ts`
  - Exports (values): `_dataViewCustomValues`
  - Resources:
    - `data-view-custom-column-defs` (push, notified)
    - `data-view-custom-values` (push, unbounded: one DataView surface's custom-column cells, indexed client-side onto every rendered row; the key is the composite (dataViewId, rowKey, columnId), so no single-id :rows read fits)
  - Routes:
    - `POST /api/data-view/custom-values`
    - `POST /api/data-view/custom-values/delete-column`
- Core:
  - Uses:
    - `ids.defineIdKind`
    - `ids.IdOf`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `CustomColumnDef`
    - `CustomColumnId`
    - `CustomColumnValueRow`
    - `DeleteCustomColumnValuesBody`
    - `SetCustomColumnValueBody`
  - Exports (values):
    - `CUSTOM_COLUMNS_SET`
    - `customColumnDefs`
    - `CustomColumnDefSchema`
    - `customColumnIdKind`
    - `CustomColumnValueRowSchema`
    - `customColumnValues`
    - `deleteCustomColumnValues`
    - `DeleteCustomColumnValuesBodySchema`
    - `setCustomColumnValue`
    - `SetCustomColumnValueBodySchema`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deploy-history`
    - `apps/events/sources/source-detail/runs`
    - `apps/studio/compositions/release`

<!-- AUTOGENERATED:END -->
