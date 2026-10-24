# Places — filter presets, map + side panel, AND-of-OR tag filter

## Context

The Places app's tabs (`All places / Gallery / List`) are data-view saved views, each hardcoding both a
filter and a display type. The user wants tabs to be **filter presets only**: every preset shows the map,
and the place list or gallery is a side panel toggled on any preset. Validated in prototype
`proto-1792633470-xjmmji` (chosen variants: presets listed in the tag sidebar, card drills into the
panel, panel scoped to the map view, collapsed sidebar → preset pill, no preset actions while collapsed).

Requirements:
1. **Presets = filters.** Map always; right side panel `list | gallery | hidden` (surface-level, device-local),
   header `In view N | All M` (In view = places inside the uncovered map area, follows panning), footer
   "K more outside the map · Fit map · Show all", empty state. Row hover ↔ pin highlight. Row click opens
   the place card in the panel's place (Back returns); the map pans only if the pin is covered.
2. **Preset list at the top of the tag sidebar**: icon, name, count, dirty dot, ⋯ (rename / duplicate /
   delete), "+ New preset"; drag-reorder (All places pinned first); ⌥1–9 switches.
3. **Stable presets.** Tag edits go to a working copy (dirty dot). Tag box actions: Reset · Save as new ·
   Update (All places: Clear · Save as preset). Switching preset discards the edits with a toast
   "X reset to its saved filter" + Undo (restores edits and switches back).
4. **Collapsed sidebar**: sidebar gone; toolbar top-left shows a pill (expand · icon · name · count · dirty
   dot · ▾ → preset menu, draggable). No tag chips, no preset actions while collapsed.
5. **Tag filter = AND of OR-rows.** A clicked tag joins the row whose tags share its root tag (or), else a
   new row (and). In the tag box, every `or` between chips splits the row, every `and` between rows merges
   them; chips drag between rows / onto "and …". Replaces the any/all switch.

## Design

Generic where a second consumer would want it; Places-specific otherwise.

- **Drafts (view-core, generic).** Opt-in per-instance working copy of the whole `view` blob. Every
  `core.updateView` on a drafted instance (filter, sort, groupBy — so the sidebar and the filter panel
  alike) edits the draft; rename/icon/reorder stay durable. Stored in sessionStorage
  `${storageKey}:view-drafts` (per browser tab, like the query). A write equal to the saved blob drops the
  draft. data-view adds the discard-on-switch toast + Undo and the `home` view (pinned first, not
  draggable/renamable/deletable).
- **Panel = composition, not a data-view layout mode.** The presets DataView holds only `map`-type
  instances (`backdrop="map"` keeps the camera mounted). New generic `asideEnd` slot (right floating card,
  mirror of `aside`, inside the controls provider). Places renders `PlacesPanel` there: it reads the active
  preset's rows via `useFlatRows(useDataViewControls())`, scopes them to the visible map bounds and feeds a
  second DataView `places.panel` (`pinnedView={layout}`, views `list|gallery`, hosted body-only frame).
- **Row hover (generic):** `hoveredRowId` / `onRowHoverChange` on DataView props + render props,
  implemented by list, gallery, map (bridged to `MapView.hoveredId`; ghost-pin hover wins when non-null).
- **Map (generic):** `CameraRest.visible: MapBounds` (uncovered area; re-reported when `fitPadding`
  changes), `boundsContain(b, p)` (antimeridian-aware), `fitRequest?: number` (re-frames on change).
- **Preset list + pill (generic):** view-core `ViewList` (vertical `SortableList`, home disabled, inline
  rename, ⋯ DropdownMenu, "+ New …"); `CollapsedViewSwitcher` gains `menu: "list"` + `countFor/dirtyFor`.
  data-view: `DataViewViewList`, `useViewRowCounts()`, `switcherForm: "strip" | "chip" | "none"`,
  `viewShortcuts` (⌥1–9 via `useSurfaceShortcuts`). floating-toolbar renders the tabs card only when it has
  a title or switcher.
- **AND-of-OR rows (Places only):** representation = one `has-nested` rule per row under the `and` root —
  what `sidebar-filter.ts` already writes for "all"; old "any" reads as one row. No data-view change.
- **Fresh storage key.** The presets DataView uses `defineDataView("places.presets")`, with a new committed
  config containing only `All places` (`type: map`, no filter). Tag ids are per-user DB ids, so no seeded
  Restaurants/Cultural presets — the user creates them (Save as preset). The old `places.map` config (user
  layer still holds Gallery/List rows and a filtered All places) is left orphaned rather than migrated:
  migrations are shared across view ids and the old rows would otherwise render as floating cards.
  Gallery/List rows move to the new `places.panel` config.

Decisions on open points: no preset colour (icon only); panel sort = list by name, gallery by createdAt
(as today); drafts per browser tab (sessionStorage).

## New APIs

view-core (`plugins/primitives/plugins/data-view/plugins/view-core`):
```ts
useViewModel(storageKey, descriptors, entries, defaultView, pinnedView?, opts?: { drafts?: boolean })
ViewModelCore += { viewFor(id); savedViewFor(id); dirtyFor: ViewGetter<boolean>; drafts: ViewDrafts | null }
interface ViewDrafts {
  save(id): void; discard(id): VariantValue | null; restore(id, view): void;
  saveAsNew(id, row: { name: string; icon?: SavedSymbolName }): string;
}
duplicateView(id, overrides?: { name?; icon?; view? }) → id
ViewList, CollapsedViewSwitcher({ menu?: "menu" | "list", countFor?, dirtyFor? })
```
data-view:
```ts
DataViewProps += { viewEdits?: { mode: "draft"; home?: string }; switcherForm?: "strip"|"chip"|"none";
  viewShortcuts?: true; asideEnd?: ReactNode; hoveredRowId?: string|null; onRowHoverChange?(id) }
DataViewRenderProps += { hoveredRowId?; onRowHoverChange? }
ReadyViewModel += { dirtyFor; drafts; homeViewId; renamingId; setRenamingId }
DataViewControlsContextValue += { rows: readonly unknown[] | null }
useViewRowCounts(): (viewId) => number | undefined
DataViewViewList({ newLabel, onNew? })
```
map (`plugins/map`, `plugins/primitives/plugins/data-view/plugins/map`):
```ts
CameraRest += { visible: MapBounds }; boundsContain(b, p): boolean; MapViewOptions.fitRequest?: number
```

## Places changes (`plugins/apps/plugins/places/plugins/places-map/`)

- `web/internal/sidebar-filter.ts`: state `{ rows: string[][]; exclude: string[] }`; `rootOf`,
  `includeTag` (facet rule + subsumption), `cycleTag`, `removeTag`, `splitRow`, `mergeRows`, `moveTag`,
  `presetAutoName`, `presetIcon`; `applySidebarState` writes one `has-nested` per row. Tests rewritten
  (incl. `(Museums or Viewpoints) and Want to go`, old any/all read).
- `web/components/tag-filter-box.tsx` (new): rows of chips with `or`/`and` toggles, HTML5 chip drag,
  "Not tagged" row, dirty actions.
- `web/components/tag-sidebar.tsx`: `DataViewViewList` on top, collapse button, tag box, tree; any/all
  switch and fold-to-header removed.
- `web/components/places-panel.tsx` (new) + `web/internal/panel-scope.ts` (pure, tested) +
  `web/internal/layout-stores.ts` (sidebar open, panel layout, scope).
- `web/components/places-screen.tsx`: `views={["map"]}`, `viewEdits={{mode:"draft", home:"all"}}`,
  `viewShortcuts`, `switcherForm={open ? "none" : "chip"}`, `aside`, `asideEnd`, shared
  `hoveredPlaceId`, `visible` from `onCameraRest`, `fitRequest`; the floating `PlaceCard` only when the
  panel is hidden (else it drills in the panel).
- Config: `config/apps/places/places-map/places.presets.jsonc` (All places), `places.panel.jsonc`
  (list, gallery rows moved from `places.map.jsonc`); delete the committed `places.map.jsonc`.
- `CLAUDE.md` updated; `e2e/backdrop-panel.ts` rewritten/retired; new `e2e/presets.ts`.

## Work packages

Parallel, disjoint files, API contract above:
- **WP1 data-view + view-core + floating-toolbar + list + gallery**: drafts, home, switcherForm, asideEnd,
  viewShortcuts, ViewList, pill, counts, DataViewViewList, row hover. Adds the two render-prop fields.
- **WP2 map**: `CameraRest.visible`, `boundsContain`, `fitRequest`, map-view hover bridge.
- **WP3a Places sidebar model**: `sidebar-filter.ts` rows + tests + `tag-filter-box.tsx` (against today's
  `filter.setFilter`).
- **WP3b Places integration** (after the three above): everything else in Places.

## Risks

- Draft dirtiness vs fresh filter rule ids (an edit-then-undo may stay dirty) — compare ignoring
  `FilterNode.id` if it shows.
- `useViewRowCounts` evaluates every preset's filter — memoize per state identity.
- ⌥digit in text inputs (macOS character input) — shortcuts must skip editable targets.
- Card placement interplay (drill card, Ask thread, tag manager, fit-padding probe) — re-check each state.

## Verification

- `./equin test` on view-core, data-view, map, places-map (draft engine, setActiveView discard/undo,
  `boundsContain`, `sidebar-filter`, `panel-scope`).
- `./equin build`; screenshots of `/places` (sidebar open/collapsed, panel list/gallery/hidden,
  dirty preset, In-view empty, drill) via `e2e-harness/e2e/screenshot.ts`.
- `places-map/e2e/presets.ts`: dirty → Update; switch → toast → Undo; ⌥2; drag reorder (All first); pan
  changes In-view count; row hover lifts pin; drill + Back. Rerun `camera-stays.ts`, `click-away.ts`.
