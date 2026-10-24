# DataView ↔ custom-columns dependency inversion

## Context

The DataView host (`plugins/primitives/plugins/data-view`) currently reaches
**down** into its `custom-columns` sub-plugin to (a) render the "Fields" settings
panel and (b) inject the per-row custom-column `FieldDef[]`. Because that
`host → custom-columns` edge exists, `custom-columns` **cannot** import
data-view's barrel — so it cannot contribute to the generic
`DataViewSlots.Setting` menu (that would close a `data-view ↔ custom-columns`
plugin cycle). The consequence is two special cases in the host:

- the settings menu takes a bespoke `customColumns: ReactNode` prop and appends
  it inside the global scope **outside** the `renderIsolated` slot loop (a
  non-slot member of the "DataView" section), instead of custom-columns being a
  real `Setting` contributor; and
- the FieldDef injection runs through a host-owned bridge
  (`useCustomColumnFields`) that hard-imports custom-columns hooks, parallel to —
  but bypassing — the generic `fieldExtensions` seam.

**Goal:** invert the dependency. `custom-columns` imports data-view's barrel and
contributes (1) its Fields UI via `DataViewSlots.Setting` (`scope: "global"`) and
(2) its per-row `FieldDef[]` via a **global field-extension slot**. Remove
**every** `data-view → custom-columns` import. Then the host names no individual
setting (full collection-consumer separation) and the global-scope built-in
special case disappears.

## Key constraints discovered

1. **config_v2 writes are strict.** `setConfig(descriptor, "customColumns", …)`
   (`config_v2/server/internal/registry.ts`) does `descriptor.fields[key].schema.parse(...)`
   and throws `TypeError` if `customColumns` is **not** declared on the
   descriptor. Reads are `.passthrough()`-tolerant, but writes are not — so the
   `customColumns` listField declaration is **mandatory** and must stay in the
   descriptor data-view builds. It therefore **cannot** be imported from
   custom-columns (cycle) → it moves into data-view. (Its current file
   `custom-columns/core/internal/extra-fields.ts` imports only `fields/core`
   builders, so the move is a pure relocation.)

2. **`fieldExtensions` is a per-consumer factory** (`defineFieldExtensions<TRow>`),
   passed as a prop, with `{ render }`-only contribution props and no
   `storageKey`/`rowKey` channel. It is the wrong shape for a **global, always-on,
   every-DataView** contribution. Custom-columns needs a **new global slot** whose
   contributions receive `{ storageKey, rowKey, render }`. (Sonata's
   `apps/sonata/library` is the only `fieldExtensions` consumer and stays
   untouched.)

3. **The `customColumns?: boolean` opt-out has zero consumers** repo-wide →
   **drop it** (decided). Custom-columns becomes unconditional.

4. **Descriptor reference identity.** `useConfig`/`useSetConfig` match by `===`
   against the object in `dataViewDescriptors` (`web/internal/descriptors.ts`).
   custom-columns must resolve the **same** object → data-view's web barrel must
   export a lookup.

## The three edges to remove

| # | File (host side) | Imports from custom-columns |
|---|---|---|
| A | `web/components/data-view.tsx` | `useCustomColumnDefs`, `CustomColumnsFields` (web) |
| B | `web/internal/use-custom-column-fields.ts` | `useCustomColumnValues`, `useSetCustomColumnValue` (web), `CustomColumnDef` (core) |
| C | `web/internal/descriptors.ts` **and** `server/internal/config-registrations.ts` | `customColumnsExtraFields` (core) |

## Plan

### 1. Move the config-field declaration into data-view (`shared/`) — kills edge C

- **Move** `plugins/primitives/plugins/data-view/plugins/custom-columns/core/internal/extra-fields.ts`
  → `plugins/primitives/plugins/data-view/shared/custom-columns-field.ts`, exporting
  `customColumnsExtraFields` (verbatim — it already imports only `fields/core`
  `listField`/`textField`). Mirrors the existing `shared/sort-presets-field.ts`
  (`presetsExtraFields`).
- Remove the `customColumnsExtraFields` re-export from
  `custom-columns/core/index.ts`.
- Update the two merge sites to import from `../custom-columns-field` (web:
  `web/internal/descriptors.ts`; server: `server/internal/config-registrations.ts`).
  The merged field set is byte-for-byte identical, so **no origin-hash churn** for
  the ~22 committed data-view configs.
- **Export a descriptor lookup** from `data-view/web/index.ts`:
  `getDataViewDescriptor(id: DataViewId): ConfigDescriptor | undefined`
  = `dataViewDescriptors.get(id)`. Generic — names no contributor.

> custom-columns keeps its own `CustomColumnDef` type + `readCustomColumnDefs`
> normalizer; data-view's moved FieldsRecord stays opaque `{id,label,type}`
> textFields (no `CustomColumnDef` import), exactly as today.

### 2. Add a global field-extension slot — enables edge B inversion

In `web/slots.ts`:

```ts
export interface GlobalFieldExtensionProps {
  storageKey: DataViewId;
  rowKey: (row: unknown, index: number) => string;
  render: (fields: FieldDef<unknown>[]) => ReactNode;
}
export interface GlobalFieldExtensionContribution {
  id: string;
  component: ComponentType<GlobalFieldExtensionProps>;
  order?: number;
}
// in DataViewSlots:
FieldExtension: defineRenderSlot<GlobalFieldExtensionContribution>(
  "primitives.data-view.field-extension",
  { docLabel: (p) => p.id },
),
```

Fold it in the host **alongside** the existing per-consumer fold. Generalize
`CollectFieldExtensions`/`FieldExtensionStep` (`web/internal/field-extensions.tsx`)
to accept an optional `extraProps` object spread into each contribution's props
(reusing the recursive-mount-for-hook-stability machinery — no duplicate
recursion). In `DataView` (`web/components/data-view.tsx`), nest:

```tsx
<CollectFieldExtensions
  descriptor={DataViewSlots.FieldExtension}      // global, always folded
  base={props.fields}
  extraProps={{ storageKey: props.storageKey, rowKey: props.rowKey }}
>
  {(f1) => (
    <CollectFieldExtensions descriptor={props.fieldExtensions} base={f1}>
      {(f2) => <DataViewWithModel {...props} fields={f2} />}
    </CollectFieldExtensions>
  )}
</CollectFieldExtensions>
```

The global fold passes `{ render, storageKey, rowKey }`; the per-consumer fold
passes `{ render }` (Sonata unchanged). `FieldExtensionProps<TRow>` stays
`{ render }`.

### 3. Move the FieldDef bridge into custom-columns — kills edge B

- **Delete** `web/internal/use-custom-column-fields.ts` from the host.
- Add `custom-columns/web/components/custom-column-field-extension.tsx`:

```tsx
function CustomColumnFieldExtension({ storageKey, rowKey, render }: GlobalFieldExtensionProps) {
  const descriptor = getDataViewDescriptor(storageKey);
  // Soft-disable (unregistered storageKey) preserves the old `descriptor != null`
  // gate. storageKey is stable per surface → the branch is hook-order-stable.
  if (!descriptor) return <>{render([])}</>;
  return <Inner descriptor={descriptor} storageKey={storageKey} rowKey={rowKey} render={render} />;
}
```

  `Inner` folds the old bridge logic: `useCustomColumnDefs(descriptor)`,
  `useCustomColumnValues(storageKey)`, `useSetCustomColumnValue()`, then maps each
  `CustomColumnDef` → `FieldDef<unknown>` (value/onEdit keyed by
  `rowKey(row, 0)` + `columnId`, `sortable`/`filterable: true`) and calls
  `render(fields)`. This is the exact body of the deleted `useCustomColumnFields`,
  now living where it belongs (custom-columns imports data-view's `FieldDef`/
  `DataViewId`).
- Register it: `DataViewSlots.FieldExtension({ id: "custom-columns", component: CustomColumnFieldExtension })`
  in `custom-columns/web/index.ts` `contributions`.

### 4. Make the Fields UI a real Setting contribution — kills edge A

- **Export** `useDataViewSettings` from `data-view/web/index.ts` (currently
  internal in `web/components/settings/settings-context.tsx`) so contributors can
  read the settings context. `DataViewSettingsContextValue.storageKey` is the
  `DataViewId` custom-columns needs.
- Add `custom-columns/web/components/custom-columns-setting.tsx`:

```tsx
function CustomColumnsFieldsSetting() {
  const { storageKey } = useDataViewSettings();
  const descriptor = getDataViewDescriptor(storageKey);
  if (!descriptor) return null;
  const { defs, ...actions } = useCustomColumnDefs(descriptor);
  return <CustomColumnsFields defs={defs} actions={actions} />;
}
```

  (`CustomColumnsFields` — the content-only add/rename/delete section — stays in
  custom-columns; it was already built wrapper-free for exactly this.)
- Register `DataViewSlots.Setting({ id: "custom-columns", scope: "global", component: CustomColumnsFieldsSetting })`
  in `custom-columns/web/index.ts`.
- **Simplify the host settings menu** (`web/components/settings/settings-menu.tsx`):
  drop the `customColumns: ReactNode` prop and the append-after-loop special case;
  `globalScopeVisible = globalSettings.length > 0`. Global-scope contributions now
  render **uniformly** through `renderIsolated` (custom-columns among them,
  error-boundary-isolated like every other setting).
- Update the settings-context doc comment (remove the "host-rendered, cannot
  import the slot" note).

### 5. Drop the opt-out + remove dead code

- Remove `customColumns?: boolean` from `DataViewProps`
  (`core/internal/types.ts`) and all `customColumnsEnabled`/`descriptor` gating in
  `data-view.tsx` (the global fold is now unconditional).
- Remove the now-unused `DataViewSettingsButton` (legacy standalone gear) from
  `custom-columns/web/components/data-view-settings-button.tsx` + its barrel export
  (keep `CustomColumnsFields`).
- `custom-columns/web/index.ts` gains a non-empty `contributions: [ …Setting, …FieldExtension ]`.

### Resulting dependency direction

`custom-columns → data-view` only (legal parent-ward edge). data-view imports
**nothing** from custom-columns. custom-columns/web new imports:
`DataViewSlots`, `getDataViewDescriptor`, `useDataViewSettings`,
`GlobalFieldExtensionProps` (from `data-view/web`) and `FieldDef`, `DataViewId`
(from `data-view/core`).

## Critical files

- `plugins/primitives/plugins/data-view/web/slots.ts` — new `FieldExtension` slot + props types.
- `plugins/primitives/plugins/data-view/web/internal/field-extensions.tsx` — generalize fold with `extraProps`.
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — nest global fold; delete custom-columns wiring + `customColumnsEnabled`.
- `plugins/primitives/plugins/data-view/web/components/settings/settings-menu.tsx` — drop `customColumns` prop + special case.
- `plugins/primitives/plugins/data-view/web/index.ts` — export `getDataViewDescriptor`, `useDataViewSettings`, slot types.
- `plugins/primitives/plugins/data-view/shared/custom-columns-field.ts` — moved FieldsRecord.
- `plugins/primitives/plugins/data-view/web/internal/descriptors.ts` + `server/internal/config-registrations.ts` — import from `shared/` not custom-columns.
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — drop `customColumns?: boolean`.
- **Delete** `plugins/primitives/plugins/data-view/web/internal/use-custom-column-fields.ts`.
- `plugins/primitives/plugins/data-view/plugins/custom-columns/web/index.ts` — new contributions.
- `plugins/primitives/plugins/data-view/plugins/custom-columns/web/components/{custom-column-field-extension,custom-columns-setting}.tsx` — new.
- `plugins/primitives/plugins/data-view/plugins/custom-columns/core/index.ts` + `core/internal/extra-fields.ts` — drop `customColumnsExtraFields` (moved).
- CLAUDE.md updates: `data-view/CLAUDE.md` (Field extensions / Setting sections),
  `custom-columns/CLAUDE.md` (now a contributor, not host-pulled).

## Verification

1. `./equin build` — regenerates registry + descriptors; confirms no
   boundary/cycle violation and the plugin-doc/registry in-sync checks pass. The
   `plugins-registry-in-sync` and `data-views-in-sync` checks must stay green.
2. `./equin check plugin-boundaries` — confirms the `data-view ↔
   custom-columns` cycle is gone and `custom-columns → data-view` is the only edge.
   `./equin check` (all) — especially `config-origins-in-sync` (should be
   clean: identical field set ⇒ no hash churn) and `type-check`.
3. App smoke test at `http://<worktree>.localhost:9000` on a DataView surface
   (e.g. Sonata library `/sonata`, or Tasks): open the settings gear → the
   **Fields** section renders (now a real slot contribution); add a column →
   it appears as a sortable/filterable table column and in the Sort/Filter/
   Properties pills; edit a cell → value persists (live resource). Confirm
   Sonata's own `fieldExtensions` play-count/last-played fields still appear
   (per-consumer fold intact).
4. `bun run test:dom plugins/primitives/plugins/data-view` +
   `bun test plugins/primitives/plugins/data-view` if present — run existing
   data-view tests to catch fold regressions.
