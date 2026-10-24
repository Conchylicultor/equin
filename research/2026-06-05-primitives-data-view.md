# Data-View primitive — a Notion-like multi-view data surface

## Context

The Sonata song library (`plugins/apps/plugins/sonata/plugins/library/`) currently hand-rolls a
CSS grid of `SongCard`s backed by a live `songsResource`. There is no way to switch to a table,
no sort, no search. We want the same dataset to be renderable as **a gallery of cards**, **a table
with metadata columns**, and (later) **tree / board / calendar** — with built-in search now and
per-field filtering later. This is the *Notion database* model: one **data source** (rows + a typed
field schema) rendered through multiple **views**, each view independently configured.

This is load-bearing infra: it's the building block that lets agents compose data surfaces from a
field schema, which is squarely on the path to "Notion-like WeChat where agents compose apps from
plugins". So it must be a clean primitive, not a Sonata-specific widget.

We already have adjacent primitives — `tabbed-view` (view switching), `data-table`
(sortable/filterable columns), `tree`/`TreeList` (composable rows), `search`, `filter-chips`. The
data-view primitive **reuses** these rather than replacing them. The key new idea is a single
**unified field schema** that drives every view, plus a **single global view registry** so adding a
new view type is a new plugin with zero consumer changes.

### Decisions locked in (from the user)

1. **V1 scope = Gallery + Table + Search**, then migrate Sonata. Tree is Phase 2, per-field filter
   bar is Phase 3.
2. **Card model = mixed**, mirroring the tree row: a field-driven default card *and* a composable
   `DataCard` chrome with named regions (media / body / actions / footer) that the consumer fills —
   and into which the consumer can wire **slots** so other plugins contribute extensions (exactly
   how `tasks` wires `<TaskActions.Render>` into `RowChrome`'s `actions`).
3. **Per-view independent sort / filter / search**, Notion-style. State is owned per view, not
   shared, and the model is forward-compatible with multiple named views per type.

---

## Architecture

### Why a single global `View` slot + a `<DataView>` component (not a `defineTabbedView` factory)

`defineTabbedView` is a *factory* because each tab host has a **different** set of tabs. Our views
(gallery, table, tree, …) are a **fixed shared vocabulary** every consumer draws from — the inverse.
This is exactly the `segmented-progress-bar` precedent: one global `Variant` slot, children
(`dots`/`segmented`) each contribute one variant, the consumer picks the active one by id via
`renderIsolated` and never imports a child. We follow that precedent.

```
plugins/primitives/plugins/data-view/         (umbrella)
├── core/         FieldDef, ViewState, DataViewRenderProps, DataViewProps   (shared types)
├── web/          DataView.View slot + <DataView> host component + state hook + toolbar/switcher
└── plugins/
    ├── gallery/  contributes View("gallery"); exports DataCard chrome + GalleryViewOptions
    ├── table/    contributes View("table");   wraps data-table
    └── tree/     contributes View("tree")     (Phase 2; wraps TreeList)
```

- The `View` slot is a **plain `defineSlot`** (like tabbed-view's `View` / segmented's `Variant`),
  rendered via `renderIsolated` — *not* `defineRenderSlot`. This sidesteps reorder middleware
  entirely (the switcher order comes from the `views` prop / `order`, never DnD).
- **Collection-consumer separation holds**: a consumer writes `views={["gallery","table"]}` (view-type
  ids in the shared vocabulary, matching the segmented precedent of storing `"dots"`), imports only
  the umbrella's `DataView` + core types, and never imports `data-view/plugins/gallery`. Adding a
  `board` view is a new child plugin with zero consumer edits.

### Unified field schema — `FieldDef<TRow>` (the source of truth for every view)

Lives in `data-view/core` so view children **and** consumers share it.

```ts
// data-view/core/internal/types.ts
export type FieldValue = string | number | boolean | Date | null | undefined;

// Forward-compatible taxonomy; drives sort comparison, default search inclusion,
// and (Phase 3) which filter control the future filter bar renders for the field.
export type FieldType = "text" | "number" | "date" | "boolean" | "enum" | "media";

export interface FieldDef<TRow> {
  id: string;
  label: string;
  type?: FieldType;                          // default "text"
  value?: (row: TRow) => FieldValue;         // comparable projection — sort/search/filter
  cell?: (row: TRow) => ReactNode;           // custom renderer; falls back to String(value ?? "")
  sortable?: boolean;                        // default: true when `value` present
  filterable?: boolean;                      // include in default search accessor; default true for text/enum
  width?: string;                            // tailwind width class, passed to table column
  options?: { value: string; label: string }[]; // type:"enum" → enables Phase 3 chip/multiselect
  cover?: boolean;                           // type:"media" → gallery cover source
}
```

- **Table** maps `FieldDef → data-table ColumnDef` 1:1 (coercing `Date→ms`, `boolean→0/1` for the
  `value` projection, since `ColumnDef.value` is `string|number|undefined`).
- **Gallery** builds a default card from fields (title = first `text` field; remaining `cell`/`value`
  as property rows; `cover` field as media), with composable/override hooks (below).
- **Tree** (Phase 2) renders cells from fields inside `RowChrome`.

### Per-view state — independent sort / filter / search (the Notion model)

Each **view instance** carries its own state; switching gallery↔table preserves each view's own
sort/filter/search. State is persisted per `(storageKey, viewId)`.

```ts
export interface SortState { fieldId: string; direction: "asc" | "desc"; }

export interface ViewState {
  sort: SortState | null;
  query: string;                              // per-view quick search
  filters: Record<string, unknown>;           // Phase 3: per-field filter values (keyed by field id)
}
```

- The host owns `Record<viewId, ViewState>` (lazy-initialized, persisted to localStorage under
  `${storageKey}:view-state` plus the active id under `${storageKey}:active-view`, reusing
  tabbed-view's exact `try/catch (DOMException)` guard).
- The host computes the **processed rows for the active view only** from *that view's* state — via a
  shared `useDataViewRows(rows, fields, viewState, searchAccessor)` hook (search → filter → sort,
  reusing `useDataTable`'s comparator logic and `search`'s substring match).
- The active view receives its processed rows + its `ViewState` + setters; a table header click
  calls `setSort(fieldId)` which writes **that view's** sort only.
- **Forward-compatible with full Notion**: today `viewId` is the view-type id (one instance per
  type). Later, multiple named views per type become extra entries in the same
  `Record<viewId, ViewState>` map + a richer switcher — no contract change to views or fields.

### Common render contract — `DataViewRenderProps<TRow>`

```ts
export interface DataViewRenderProps<TRow> {
  rows: readonly TRow[];                       // AFTER this view's search+filter+sort
  fields: FieldDef<TRow>[];
  rowKey: (row: TRow, index: number) => string;
  state: ViewState;                            // this view's own state
  setSort: (fieldId: string) => void;          // null→asc→desc→null cycle, writes this view's sort
  setFilter: (fieldId: string, value: unknown) => void; // Phase 3
  onRowActivate?: (row: TRow) => void;          // row/card click (default cards & table rows)
  options: unknown;                            // viewOptions[activeViewId] — opaque to host
  emptyState?: ReactNode;
}
```

`renderIsolated` casts processed rows to `unknown` at the slot boundary; each view re-casts to its
`TRow` — the same `as unknown as` pattern tabbed-view already uses for `viewProps`. Isolated to two
cast sites.

### Card model — composable chrome + field-driven default + consumer-wired slots

Mirror `RowChrome`. The gallery child exports a **`DataCard`** chrome primitive with named regions,
and a default card built from `fields`. The consumer picks its level of involvement:

- **Free**: pass nothing → gallery renders the field-driven default card.
- **Compose**: pass `renderCard(row) => <DataCard media={…} actions={…} footer={…}> …custom… </DataCard>`
  to fill regions while reusing the chrome (hover-reveal, focus, grid sizing).
- **Replace**: `renderCard` returns a fully custom element (Sonata's `SongCard`).
- **Plugin-extensible**: the consumer can wire a **slot** into a region (e.g.
  `actions={<SonataCardActions.Render … />}`), so *other* plugins contribute card extensions —
  exactly how `tasks` wires `<TaskActions.Render>` into `RowChrome.actions`. The data-view primitive
  stays generic; the contribution surface is owned by the consumer, correctly scoped.

```ts
// gallery/core/internal/types.ts
export interface GalleryViewOptions<TRow> {
  renderCard?: (row: TRow) => ReactNode;       // compose-with-DataCard OR full replace
  coverField?: string;                         // override which field is the cover
  minCardWidth?: number;                       // grid sizing, default 200
}
// gallery/web exports: GalleryView (contribution), DataCard chrome, GalleryViewOptions
```

`DataCard` regions: `media` (cover/icon), body (field cells, auto from `fields` — title prominent +
property rows), `actions` (hover-revealed top-right), `footer` (badges/affordances). It carries the
`group` + focus + click(`onRowActivate`) behavior so consumers don't re-implement it.

### Per-view options channel

A single `viewOptions?: Record<string, unknown>` prop on `DataView`, keyed by view id. The host
treats it as opaque, threads `viewOptions[activeViewId]` into `DataViewRenderProps.options`; each
view casts it to its own typed options internally (`props.options as GalleryViewOptions<TRow>`). This
keeps the host fully decoupled from view internals (the sealed-slot reality — the host genuinely
cannot know contributor types). Each child *also* exports a tiny typed helper
(`galleryOptions<TRow>(o): ["gallery", o]`) for consumers who want compile-time checking without the
host being generic.

### Search now, filter later

- **Search (V1)**: a `SearchInput` in the host toolbar bound to the active view's `state.query`.
  Default `searchAccessor` is derived from fields where `filterable !== false` (text/enum), joining
  `String(value(row) ?? "")`; consumer override via a `searchAccessor?: (row) => string` prop. Reuses
  `search`'s substring logic.
- **Filter (Phase 3 sketch — not built now)**: a `filters` map already exists on `ViewState` and
  `setFilter` on the contract. Add a filter-bar region that, per `filterable` field, picks a control
  by `field.type` (`enum`→multi-select over `options`, `text`→contains, `number`/`date`→range), writes
  into `state.filters`, applied in `useDataViewRows` before sort. **No `FieldDef` rework needed.**
  Caveat: `filter-chips` is single-select only; multi-select enum filtering will need the
  `multi-select` primitive or a multi-select extension to filter-chips.

---

## Sonata migration (the concrete deliverable)

`song-library.tsx` becomes a thin `<DataView>` adapter; data flow (`useResource(songsResource)`),
the import flow, `SongCard`, and all server code are **untouched**.

```tsx
export function SongLibrary() {
  const songs = useResource(songsResource);
  // ...open(song) + importFile(file) unchanged...

  const fields: FieldDef<Song>[] = useMemo(() => [
    { id: "title",    label: "Title",    type: "text",   value: s => s.title,                        sortable: true, filterable: true },
    { id: "composer", label: "Composer", type: "text",   value: s => s.composer ?? "Unknown",        sortable: true, filterable: true },
    { id: "duration", label: "Length",   type: "number", value: s => s.durationSec, cell: s => formatDuration(s.durationSec), sortable: true, width: "w-20" },
    { id: "added",    label: "Added",    type: "date",   value: s => s.createdAt,                     sortable: true },
  ], []);

  return (
    <>
      {songs.error ? <ErrorBanner …/> : null}
      <DataView<Song>
        rows={songs.pending ? [] : songs.data}
        fields={fields}
        rowKey={s => s.id}
        views={["gallery", "table"]}
        defaultView="gallery"
        storageKey="sonata:library"
        title="Library"
        actions={<ImportButton importing={importing} onPick={importFile} />}
        onRowActivate={s => void open(s)}
        emptyState={<>No songs yet — import a MIDI file to get started.</>}
        viewOptions={{ gallery: { renderCard: s => <SongCard song={s} onOpen={open} /> } }}
      />
    </>
  );
}
```

- The `grid-cols-[repeat(auto-fill,minmax(200px,1fr))]` container moves into the gallery view; the
  custom `SongCard` (play affordance + hover-delete) slots in via `renderCard`, unchanged.
- The header "Library" title + Import button move to `DataView`'s `title` / `actions` toolbar regions.
  `formatDuration` is lifted from `song-card.tsx` into a tiny shared util (or imported) so the field
  `cell` and the card both use it.
- `web/index.ts` contribution (`Sonata.Home({ id: "library", component: SongLibrary })`) is unchanged.

---

## Files

### Create — `plugins/primitives/plugins/data-view/`

- `package.json`, `CLAUDE.md`
- `core/index.ts` — re-export `./internal/types`
- `core/internal/types.ts` — `FieldDef`, `FieldType`, `FieldValue`, `SortState`, `ViewState`,
  `DataViewRenderProps`, `DataViewProps`
- `web/index.ts` — barrel: `export { DataView } from "./components/data-view"`,
  `export { DataViewSlots } from "./slots"`, re-export core types, `export default definePlugin(...)`
  with `contributions: []`
- `web/slots.ts` — `DataViewSlots = { View: defineSlot<DataViewContribution>("primitives.data-view.view", …) }`;
  `DataViewContribution = { id; title; icon; order?; component: ComponentType<DataViewRenderProps<unknown>> }`
- `web/components/data-view.tsx` — the generic `<DataView<TRow>>` host (toolbar: title/search/actions
  + switcher + active view via `renderIsolated`)
- `web/components/view-switcher.tsx` — segmented switcher (adapt tabbed-view chrome)
- `web/internal/use-view-state.ts` — per-view state map + localStorage persistence
- `web/internal/use-data-view-rows.ts` — search → filter → sort pipeline for the active view

### Create — children

- `data-view/plugins/gallery/` — `package.json`, `CLAUDE.md`, `core/{index,internal/types}.ts`
  (`GalleryViewOptions`), `web/index.ts` (contributes `View("gallery")`; exports `DataCard`,
  `GalleryViewOptions`, `galleryOptions`), `web/components/{gallery-view,data-card}.tsx`
- `data-view/plugins/table/` — same shape, `web/components/table-view.tsx` (maps `FieldDef→ColumnDef`,
  renders `DataTable` with controlled sort)
- `data-view/plugins/tree/` — **Phase 2**

### Modify

- `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx` — rewrite as the
  `<DataView>` adapter above. Extract `ImportButton` (and lift `formatDuration`).
- `plugins/primitives/plugins/data-table/web/internal/{types,use-data-table,data-table}.ts` — add
  **optional controlled** `sortState` + `onToggleSort` props (fall back to internal state when
  omitted — every existing caller is unaffected). This lets the table view delegate sort to the
  host's per-view state while `DataTable` remains the sole owner of table rendering. *(Additive; the
  alternative of duplicating the header in the table view was considered and rejected as it
  duplicates chrome.)*

### Boundary check

- Children importing `DataViewSlots` + core types from the umbrella: legal (segmented precedent).
- `table` child importing `data-table/web`, `tree` child importing `tree/web` + `search/web`: legal
  (separate plugins).
- Slot `const` lives in `web/slots.ts`, barrel only re-exports it; `DataCard`/`galleryoptions` are in
  `components`/`core`, re-exported by barrels. Barrel purity preserved.
- Plugin loader auto-discovers `plugins/primitives/plugins/data-view/**` (primitives have no central
  registry) — to be confirmed during build.

---

## Sequencing

- **Phase 1 (this deliverable)**: umbrella (`core` types + slot + host + `use-view-state` +
  `use-data-view-rows` + switcher) + `gallery` (incl. `DataCard`) + `table` + search + the
  data-table controlled-sort edit + Sonata migration.
- **Phase 2**: `tree` view child (wraps `TreeList`; consumes a `TreeViewOptions` with
  `onMove/onToggleExpanded/onCreate`). Validates the `viewOptions` channel handles a view needing
  mutation callbacks + `TreeItem` rows. No host changes expected.
- **Phase 3**: per-field filter bar (`FieldDef.type`-driven controls writing `state.filters`);
  extend/replace `filter-chips` for multi-select.

## Risks / call-outs

- **localStorage**: reuse tabbed-view's `DOMException` guard for SSR/Safari-private; key the view-state
  map by `storageKey`.
- **`views` ordering**: when `views` is provided it is authoritative for inclusion + order (map over
  it, resolve each id to a contribution, drop misses); when omitted, fall back to all contributions
  sorted by `order` then `title`. `order` only matters in the no-`views` case.
- **Type erasure at the slot boundary**: documented two `as unknown as` cast sites, same as
  tabbed-view.
- **`onRowActivate` vs custom `renderCard`**: a custom card owns its own click handling;
  `onRowActivate` drives default cards + table rows. Document precedence so it isn't double-wired.

## Verification

1. `./equin build`, open `http://<worktree>.localhost:9000` → Sonata → Library.
2. **Gallery parity**: cards render as before (title, composer, duration, play affordance), clicking
   opens the player, hover-delete removes a song (live update via `songsResource`).
3. **View switch**: toggle to **Table** → sortable columns (Title, Composer, Length, Added); click a
   header → sorts; switch back to Gallery → gallery's own sort/search is preserved independently
   (set different sorts in each view, confirm they don't bleed across).
4. **Search**: type in the search box → both views filter by title/composer; query persists per view.
5. **Persistence**: reload → last active view + each view's sort/search restored.
6. Scripted check: `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/… --click "Table"
   --out /tmp/dataview` to capture before/after the switch.
7. `./equin check` passes (plugin boundaries, migrations-in-sync, eslint).
