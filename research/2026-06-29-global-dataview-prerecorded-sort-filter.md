# DataView: unify prerecorded sort/filter (drop Sonata's bespoke ordering chips)

**Date:** 2026-06-29
**Category:** global (`primitives/data-view` + `apps/sonata`)

## Context

The Sonata library landing (`/sonata`) stacks **two parallel sort UIs**:

1. A bespoke `SegmentedControl` ("Newest / Most played / Recently played") backed
   by the `Library.Sort` dispatch slot — component *orderings* dispatched **around**
   the DataView (`song-library.tsx`).
2. The DataView's own **Sort pill** (multi-level `SortRule[]` over the field schema)
   which *already* has saved, named **sort presets** persisted in config
   (`use-sort-presets.ts`, and the config already authors "Title A→Z" / "Longest first").

This is exactly the anti-pattern the data-view's own CLAUDE.md warns against
("**add a typed `FieldDef`** — do **not** bolt a bespoke toggle chip onto the
toolbar … the generic substrate for saved filters, sort, grouping"). The two
"play-based" orderings only exist as bespoke components because **play-count /
last-played are not DataView fields** — they live in `playback-history`'s own live
resource (`usePlaybackHistoryMap()`), and `FieldDef.value` is a *synchronous*
`(row) => FieldValue` projection that cannot call hooks.

**Goal.** A prerecorded sort/filter is just a **named alias for an existing
`SortRule[]` / `FilterGroup`**, applied through the *same* sort/filter controllers
— never a separate system. To get there:

- Make play-count / last-played real, **cross-plugin-contributed** fields, so
  "Most played" = `[{fieldId:"playCount",direction:"desc"}]` and they appear in the
  Sort **and** Filter pills (and as table columns) for free.
- Add **filter presets** as the twin of the existing sort presets.
- Author the three orderings as `sortPresets` rows in the library config and
  **delete** the `Library.Sort` slot, the `SegmentedControl`, and the ordering
  components.

User decisions: prerecorded UX = **sort presets in the Sort pill** (not saved
views); scope = **generic primitive**; contributed fields **show as table
columns**; **seed one example filter preset**.

---

## Part 1 — Generic: cross-plugin `FieldDef` contribution into a named DataView

A plugin must be able to inject extra `FieldDef<TRow>[]` into another plugin's
DataView. Because the field's `value` closure must capture hook-loaded data, the
contribution is a **React component that yields fields via a render callback** —
the `Library.Sort` precedent lifted to field level (and lint-clean, unlike calling
contributed hooks in a loop, which `react-hooks/rules-of-hooks` rejects).

Mirror the existing **`defineItemActions<TRow>(id)`** factory exactly (disjoint
row types per consumer → factory, not a global slot — per the CLAUDE.md
collection-vs-factory rule).

### New API

- **`defineFieldExtensions<TRow>(id)`** (new web factory, data-view):
  returns a value that is *callable for contributions*
  (`MyFields({ id, component })`) and carries `.Descriptor`
  (`FieldExtensionsDescriptor<TRow>`), exactly like item-actions' `.Row`.
- Contribution shape: `{ id: string; component: ComponentType<FieldExtensionProps<TRow>> }`
  where **`FieldExtensionProps<TRow> = { render: (fields: FieldDef<TRow>[]) => ReactNode }`**.
- Types `FieldExtensionProps`, `FieldExtensionsDescriptor` live in **core**
  (type-only; `ComponentType` is a type import), the `defineFieldExtensions`
  *value* in **web** — mirroring how `ItemActionProps` / `ItemActionsDescriptor`
  are core but `defineItemActions` is web.

### Host wiring

- New internal `CollectFieldExtensions<TRow>` (data-view web): reads
  `descriptor.useContributions()` and **recursively folds** them into nested
  render-callbacks (each contributor mounts, calls its hooks, yields its
  `FieldDef[]`), accumulating, then calls `children(mergedFields)`. The
  contribution set is fixed at build time → recursion depth is stable →
  rules-of-hooks safe. Empty list → `children(baseFields)`.
- `DataViewProps.fieldExtensions?: FieldExtensionsDescriptor<TRow>` (core type).
- Restructure the outer **`DataView`** so the fold wraps model + inner and merges
  **before** the controllers, so `useSortController` / `useFilterController` /
  table columns all consume one merged `fields` array uniformly:

  ```tsx
  export function DataView<TRow>(props) {
    return (
      <CollectFieldExtensions descriptor={props.fieldExtensions} base={props.fields}>
        {(fields) => <DataViewWithModel {...props} fields={fields} />}
      </CollectFieldExtensions>
    );
  }
  ```
  (`useDataViewModel` only reads `!!hierarchy`, so moving it inside the fold is safe.)

### Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/data-view/web/internal/field-extensions.tsx` | **New** — `defineFieldExtensions` factory + `CollectFieldExtensions` fold |
| `plugins/primitives/plugins/data-view/core/internal/types.ts` | Add `FieldExtensionProps`, `FieldExtensionsDescriptor`; add `fieldExtensions?` to `DataViewProps` |
| `plugins/primitives/plugins/data-view/web/components/data-view.tsx` | Split outer `DataView` → fold wrapper → `DataViewWithModel` (model) → `DataViewInner` |
| `plugins/primitives/plugins/data-view/web/index.ts` | Export `defineFieldExtensions` + the two types |
| `plugins/primitives/plugins/data-view/core/index.ts` | Export the two types |
| `plugins/primitives/plugins/data-view/CLAUDE.md` | Document the new "Field extensions" extension point (sibling to "Per-item actions") |

Reuse, don't reinvent: model the factory byte-for-byte on
`defineItemActions` (`web/internal/item-actions.tsx`) — same `.Row`→`.Descriptor`
shape, same `useContributions` discovery, same documented `unknown`→`TRow`
re-cast at the contributor boundary.

---

## Part 2 — Generic: filter presets (twin of sort presets)

The injection seam already exists: `viewsDescriptor(id, extraFields)` spreads an
**`extraFields` `FieldsRecord`** next to `views` in one `defineConfig` descriptor
(`plugins/data-view/plugins/view-core/shared/internal/views-descriptor.ts`).
`sortPresets` rides that seam today via `sortPresetsExtraFields`
(`plugins/data-view/shared/sort-presets-field.ts`), threaded into both the web
descriptor map (`web/internal/descriptors.ts`) and the server registrations
(`server/internal/config-registrations.ts`). view-core never learns the key name.

### Steps

1. **Config field** — extend `shared/sort-presets-field.ts` (rename export to
   `presetsExtraFields`, keep a `sortPresetsExtraFields` alias if simpler) to add:
   ```ts
   filterPresets: listField({
     label: "Filter presets",
     itemFields: {
       label: textField({ label: "Label" }),
       // recursive FilterGroup → opaque JSON blob (same idea as the view blob's
       // variantField). jsonField<T> stores arbitrary JSON.
       group: jsonField<FilterGroup>({ label: "Filter" }),
     },
   })
   ```
   Import `jsonField` from `@plugins/fields/plugins/json/plugins/config/core`
   (mirrors the existing `variantField` import in views-descriptor).
   Threading is automatic — `descriptors.ts` and `config-registrations.ts` already
   pass this constant; no further wiring once the key is in it.

2. **Types** (data-view core): `FilterPreset { id: string; label: string; group: FilterGroup }`
   (twin of `SortPreset`), exported from core + web barrels.

3. **Reader hook** — new `web/internal/use-filter-presets.ts`, a line-for-line
   mirror of `use-sort-presets.ts` (optimistic mirror + JSON-guarded reconcile +
   immediate per-key write), reading `config.filterPresets` and writing
   `setConfig("filterPresets", next)`. Add a `readFilterPresets` helper twin of
   `readSortPresets` (`internal/sort-presets.ts`).

4. **Preset UI** — new `web/components/filter/presets/` mirroring
   `web/components/sort/presets/` (`preset-list.tsx`, `preset-row.tsx`,
   `save-preset-affordance.tsx`). Apply = `controller.setFilter(preset.group)`
   (pure alias into the live filter, exactly like sort's
   `controller.setRules(resolvableRules(...))`).

5. **Popover + trigger** — `filter-builder-popover.tsx` hosts `PresetList` +
   `SavePresetAffordance` (like `sort-builder-popover.tsx`);
   `filter-builder-trigger.tsx` takes a `presets: FilterPresetsController` prop
   (like `SortBuilderTrigger`). In `data-view.tsx`, call `useFilterPresets(storageKey)`
   next to the existing `useSortPresets(storageKey)` and pass it to the trigger.

### Files

`shared/sort-presets-field.ts`, `core/internal/types.ts` + `core/index.ts`,
`web/index.ts`, **new** `web/internal/use-filter-presets.ts`,
`web/internal/sort-presets.ts` (add `readFilterPresets`), **new**
`web/components/filter/presets/*`, `web/components/filter/filter-builder-popover.tsx`,
`web/components/filter/filter-builder-trigger.tsx`,
`web/components/data-view.tsx`, `CLAUDE.md` (filter section).

---

## Part 3 — Sonata: contribute fields, author presets, delete the bespoke system

### Contribute play-stat fields (`playback-history`)

Add `Library.Fields = defineFieldExtensions<Song>("sonata.library.fields")` to
the library's `Library` object (replacing the deleted `Sort`), exported from
`library/web/index.ts`. `playback-history` contributes a render-callback
component that calls `usePlaybackHistoryMap()` and yields two fields closed over
the map:

```tsx
function PlaybackFields({ render }: FieldExtensionProps<Song>) {
  const map = usePlaybackHistoryMap();
  const fields = useMemo<FieldDef<Song>[]>(() => [
    { id: "playCount", label: "Plays", type: "int", width: "5rem", align: "end",
      value: (s) => map.get(s.id)?.playCount ?? 0, sortable: true },
    { id: "lastPlayedAt", label: "Last played", type: "date", width: "8rem",
      value: (s) => { const iso = map.get(s.id)?.lastPlayedAt; return iso ? new Date(iso) : null; },
      cell: (s) => { const iso = map.get(s.id)?.lastPlayedAt; return iso ? formatRelativeTime(new Date(iso)) : "—"; },
      sortable: true },
  ], [map]);
  return <>{render(fields)}</>;
}
```
Contributed via `Library.Fields({ id: "playback", component: PlaybackFields })`.
`type:"int"`/`type:"date"` resolve operator sets → they appear in the Filter
pill automatically; `value` present + `sortable` → Sort pill + table columns.
(Gallery is unaffected — it uses the custom `SongCard`; CardMeta still shows play
stats on cards.)

`song-library.tsx`: pass `fieldExtensions={Library.Fields}` to `<DataView>`; drop
the `<Library.Sort.Dispatch>` wrapper, the `sort` `useState`, `sortOptions`, the
`SegmentedControl`, and the `actions` prop.

### Author presets in `config/apps/sonata/library/sonata.library.jsonc`

Add to the existing `sortPresets` array:
```jsonc
{ "label": "Newest",          "rules": [{ "fieldId": "added",        "direction": "desc" }] },
{ "label": "Most played",     "rules": [{ "fieldId": "playCount",    "direction": "desc" }] },
{ "label": "Recently played", "rules": [{ "fieldId": "lastPlayedAt", "direction": "desc" }] }
```
Seed one filter preset (example for the new feature):
```jsonc
"filterPresets": [
  { "label": "Unplayed",
    "group": { "kind": "group", "id": "fp-unplayed", "conjunction": "and",
      "children": [ { "kind": "rule", "id": "fp-r1", "fieldId": "playCount", "operatorId": "eq", "value": 0 } ] } }
]
```
(Confirm the `int`/`number` equals operator id during implementation — read the
number field's `FilterOperatorSet`; adjust `operatorId`/`value` to match.)

### Deletions (blast radius confirmed — no other references)

| File | Action |
|---|---|
| `library/web/components/newest-order.tsx` | **Delete** |
| `playback-history/web/components/sort-orders.tsx` | **Delete** |
| `library/web/slots.ts` | Remove `defineDispatchSlot`/`NewestOrder` imports, `SortOrderProps`, the `Sort` key; **add** `Fields` (`defineFieldExtensions`) |
| `library/web/index.ts` | Remove `export type { SortOrderProps }`; `Library` still exported |
| `library/web/components/song-library.tsx` | Remove SegmentedControl + sort state + dispatch wrapper; add `fieldExtensions` |
| `playback-history/web/index.ts` | Remove both `Library.Sort(...)`; add `Library.Fields({ id:"playback", component: PlaybackFields })` |

`Library.CardMeta` / `PlayStats` are independent — untouched.

---

## Verification

1. `./equin build` (regenerates migrations/docs, runs checks incl.
   `plugins-doc-in-sync`, `data-views-in-sync`, `type-check`, `eslint`,
   boundaries). Must pass.
2. App at `http://att-1782731194-5h3n.localhost:9000/sonata`:
   - The "Newest / Most played / Recently played" SegmentedControl is **gone**.
   - **Sort pill** lists presets: Newest, Most played, Recently played, Title A→Z,
     Longest first. Clicking "Most played" reorders the gallery by play count;
     "Recently played" by last-played. Verify against known play counts.
   - **Filter pill** offers `Plays` (number range) and `Last played` (date) plus
     the seeded **"Unplayed"** preset; applying it filters to play-count 0.
   - Switch to the **table** view → `Plays` + `Last played` columns render and
     are click-sortable.
3. Scripted check (before/after):
   ```bash
   bun e2e/screenshot.mjs --url http://att-1782731194-5h3n.localhost:9000/sonata \
     --click "Sort" --out /tmp/sort-presets
   ```
4. Cross-check play counts via MCP:
   `query_db("select song_id, play_count, last_played_at from sonata_songs_ext_playback order by play_count desc")`.
5. Optional unit test: `makeSortComparator` over a contributed-field `value`
   closure (pure, co-located `*.test.ts`).

## Risks / notes

- **Render-fold** is the one non-trivial new primitive. Keep it minimal and
  documented; it is the direct generalization of the deleted `Library.Sort`
  render-callback, so it is precedented.
- `jsonField` persists the `FilterGroup` opaquely — the config row is still
  git-promotable but not schema-validated field-by-field (acceptable; the wire
  path validates via `FilterGroupSchema` on read in the controller if desired).
- Contributed fields are global-slot-free (factory-scoped), so no other DataView
  is affected.
