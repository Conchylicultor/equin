# data-view

A Notion-like multi-view data surface. One **data source** — `rows` plus a typed
`FieldDef[]` schema — rendered through multiple **views** (gallery, table, …), each
view independently sorted / searched / filtered.

## Architecture

- A single **global `DataViewSlots.View` slot** (a plain `defineSlot`, rendered via
  `renderIsolated`). Each view type is a child plugin contributing one
  `DataViewContribution` keyed by its **`type`** id (`"table"`, `"gallery"`, …).
  This mirrors the `segmented-progress-bar` precedent (one global `Variant` slot,
  children contribute variants) — the inverse of the `defineTabbedView` factory,
  which exists because each tab host has a *different* set of tabs. Our views are a
  *fixed shared vocabulary*.
- **view-type vs view-instance.** A `DataViewContribution` is a registered
  view-*type* (the renderer: `type`, `title`, `icon`, `component`, optional
  `configSchema`). The host renders **view-instances** — a named,
  individually-configured *use* of a view-type, `{ id, name, type, options }`,
  authored in config (below); there is **no code-synthesized default mode**. The
  public `views={[…]}` whitelist is a list of **type** ids, gating the
  addable-types `+` menu.
- `<DataView>` is the host: it resolves available views, builds a unified
  `ViewModel` (active id, per-instance state, instance actions), owns the shared
  chrome (search input → `state.query`, view switcher), and renders the active
  view via `renderIsolated`. It passes **raw rows** — each view applies the
  processing matching its own semantics. Flat views call the exported `useFlatRows`
  hook (search → filter → sort); the tree view applies the shared `useRowFilter`
  predicate (subtree-preserving, mirroring search) then feeds the result to the tree
  primitive's subtree-preserving search + rank ordering — so filter/search/sort
  behave identically across every view.

## Config mode is universal (no default mode)

Every `<DataView>` is config-backed — there is **no per-mount mode branch**, and
**zero per-consumer registration boilerplate**. This mirrors `reorder` exactly:
build-time codegen scrapes the markers, the primitive registers one
`viewsDescriptor` per id under each defining plugin.

- **`defineDataView("id")` marker** (`core/internal/define-data-view.ts`) declares
  a surface id: asserts the grammar `^[a-zA-Z0-9._-]+$` (bans `:` so the id is a
  filename-safe config name) and brands the string `DataViewId` (the type of
  `DataViewProps.storageKey`). The brand is the structural guarantee — a consumer
  cannot pass a raw string, so every id is discoverable.
- **Codegen** (`framework/tooling/codegen/.../data-views-gen.ts`) scans every
  plugin's `web/**` for `defineDataView(...)` calls and emits the sorted
  `{ id, pluginId }` list to `shared/data-views.generated.ts` — `pluginId` being the
  *defining* plugin, so the config lands in the consuming plugin's tree.
  `data-views-in-sync` fails on drift; `./singularity build` regenerates it.
- **Registration** (`{web,server}/internal/{descriptors,config-registrations}.ts`)
  builds one reference-stable `viewsDescriptor` per id and spreads one
  `ConfigV2.{WebRegister,Register}` per id, **each passing the entry's own
  `pluginId`** so config_v2 derives `config/<asPath(pluginId)>/<id>.jsonc` (e.g.
  `config/apps/sonata/library/sonata.library.jsonc`). `useViewsConfig` resolves it
  via `dataViewDescriptors.get(storageKey)` — reference identity vs the
  registration, like `reorderDescriptors.get(slotId)`.

### The rows' own read: `readiness`, never `emptyState` for a failure

Pass the read backing `rows` as `readiness={result}` (any `useLive` /
`useResource` / combined result — its `status` is all the DataView reads). The
body's precedence is `server error > failed read > failed field > loading >
pending field > the view` (`web/internal/body-state.ts`; the field arms are
"A field's own read" under Field extensions): `error` renders `errorState` (default
`<ResourceErrorInline variant="block"/>` — the message with Retry, or Reload for
an out-of-date tab), `loading` renders `loadingState` (the view's skeleton), and
only `ready` reaches the view, so `emptyState` can only mean "ready, and zero
rows". There is no boolean `loading` prop: a boolean cannot say a read failed,
so a failure would render as a skeleton forever (or, set false, as empty).
Without `readiness` the rows are taken as ready (a static list). An endpoint read
becomes a result through `useEndpointResource`.

### Config is the single source of truth (fail by default)

There is **no code synthesis** of default view-instances (view-core owns the
resolver — see its CLAUDE.md). The displayed instances come **only** from the
authored `config.views` rows; zero rows → `<DataView>` renders a `Placeholder`
("No views configured — author `config/<plugin>/<id>.jsonc`") instead of crashing.
**That placeholder is only reachable once the config is KNOWN.** `useDataViewModel` returns
a union (`{ ready: false } | (ReadyViewModel & { ready: true })`), and the shell renders a
`Loading` skeleton on the loading arm — a surface whose config has not arrived has zero
instances too, and claiming it is unconfigured is a wrong answer the user then watches get
rewritten.
The forcing function that an agent compose the views in config rather than rely on
a code fallback is the views descriptor's config_v2 **`requiresAuthoredOverride`**
opt-in (in `view-core`'s `views-descriptor.ts`, carrying the authoring guidance as
prose): `./singularity build` **seeds** `config/<plugin>/<id>.jsonc` from its
origin and stamps a `// @review` marker into it, and the generic
**`config:overrides-authored`** check (`plugins/config_v2/check/`) fails while that
marker is present. The marker tests *review* — mere presence is not enough (a
`{"views": []}` file renders "No views configured" at runtime).

### The view config row

A row is authored terse (`{ name, view }`); view-core's `normalizeRows` derives
`id` on read and **array position is the canonical order** (no `rank` field) — see
view-core's CLAUDE.md. The `view` blob is `{ type, sort?, filter?, …opts }`;
`sort`/`filter`/`groupBy` are host-injected keys read via `viewFor`/`updateView`.
So are three authored-only keys (no control writes them): `filterScope`
(`"rows" | "roots"`, what a hierarchical view's filter tests — see the tree
child's CLAUDE.md "Filter"; flat views ignore it), and, read only by the
`sections` chrome, `hideWhenEmpty` and `description` (see "Sections toolbar").
`groupBy` is a `GroupByRule` (`{ fieldId, groupingId }` — see "Grouping is a field-type
contribution"), with the legacy bare `"<fieldId>"` string migrated on read. `sort` is a
`SortRule[]` (ordered multi-level; each `{ fieldId, direction }`, priority = list
order, `[]` = unsorted) and `filter` a `FilterGroup` tree. **Legacy single-`sort`
is migrated on read** — a persisted `{ fieldId, direction }` object (the old
`SortState` shape, still on disk in committed configs) coerces to `[obj]`; the file
is re-serialized to the array shape only when the user edits sort, never
proactively. The origin default stays `{ "views": [] }` with a stable hash
(independent of the registered view-types), so adding a view-type never
invalidates committed configs.

### Adoption is enforced (`no-adhoc-row-list`)

The complementary forcing function: the `data-view/no-adhoc-row-list` lint rule
(`lint/no-adhoc-row-list.ts`, `error` repo-wide) bans hand-rolling a data list as
a `.map()` of `<Row>` in feature code. Genuine transient chrome (menus, pickers,
tab strips, typeaheads) keeps `Row` with
`// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>`; the
row-rendering machinery itself (this plugin's view children, `primitives/tree`,
`reorder/editor`) is permanently exempt via its own `exempt/index.ts`. The two checks
bracket the choice: `no-adhoc-row-list` fires when you avoid DataView,
`config:overrides-authored` fires until you finish adopting it.

### The model, and where each piece of state lives

The single model is `useConfigViewModel`: config-authored instances, full
instance actions (add / rename / duplicate / delete / reorder / options
sub-form), the `EditableViewSwitcher`, and per-instance sort/filter written
**back to the config row** (durable, git-promotable). Runtime edits write the
**user-global layer** (`setConfig` with no `scopeId`, mirroring reorder) — an
`app:` scopeId would write a scope key the read path ignores until the scope is
forked, silently dropping edits on reload. The per-id descriptor already scopes
views to one surface; per-app forking stays a Settings-pane concern.

**State split** (`web/internal/use-view-ephemeral.ts` → `useViewEphemeral`, Web
Storage for non-config state):

| State | Lives in |
|---|---|
| Instance def `{ id, name, view:{ type, sort?, filter?, …opts } }` (array-ordered) | `viewsDescriptor` config row (user-global layer) |
| Active instance id | localStorage `${storageKey}:active-view` (per device) |
| Tree expand map, collapsed group sections, collapsed view section (`collapsed`, sections chrome) | localStorage `${storageKey}:view-state` (per device) |
| Search query | **sessionStorage** `${storageKey}:view-query` (per browser tab) |

The localStorage reader ignores legacy `sort`/`filter`/`query` keys in a
`view-state` blob, so no migration is needed.

**The search query is per-tab on purpose — do not move it back to
`localStorage`.** Durable narrowings are the config row's (`sort`/`filter`/
`groupBy`) and render as visible chips; a query is an ad-hoc gesture that outlives
its intent if it survives a browser restart, leaving a filtered subset that reads
as the view's whole contents. `sessionStorage` keeps the only property worth
persisting (F5 doesn't lose your place). If a query ever *should* survive, put it
in the URL — shareable, and the back button clears it.

**The expand map is the home for tree collapse state — do not put it on a domain
entity.** Collapse is per-`(surface, view-instance, row)` render state, and the
map above already keys on exactly that triple. Storing it as an entity column
instead (an `expanded` field on the row's own table) is an anti-pattern with three
concrete failure modes, all of which the repo has actually hit:

- **One flag cannot serve two views.** Two view instances over the same rows — or
  a scoped sub-tree of them, or the same tree on two devices — fight over a
  single value, so collapsing in one silently collapses the other.
- **It writes the domain.** A collapse becomes a DB write plus a change-feed
  recompute plus a live-state push to every client, and it stamps the row's
  `updatedAt` — so a purely local UI gesture rewrites a visible, sortable field.
- **It does not bound.** Expand-all is inherently `O(nodes-with-children)` and, unlike
  `view-order`'s ranks, has no invariant to exploit for a bounded write.

The map is the **only** source. `tree/web/internal/project-rows.ts` resolves a
row's expansion as `expanded?.[id] ?? defaultExpanded ?? false` — there is no
consumer-supplied accessor left to shadow it, so a collapse simply cannot be
domain data. See
`research/2026-07-28-global-tree-collapse-state-as-view-state.md` and
`research/2026-07-29-global-delete-hierarchy-expand-hooks.md`.

**Per-instance options sub-form.** A view-type's optional `configSchema`
(`FieldsRecord`) drives the settings popover's options sub-form: the host builds a
web-side `variantField({ useVariants })` from **that instance's own** addable
types (`actions.variantsFor(id)` — generic, never names a view child) and renders
it via `FieldRenderer`. The gallery's `coverField` is the reference
`configSchema`. The type picker inside that sub-form is gated exactly like the `+`
add menu (view-core's `usableTypes`), so a surface can never switch a view to a
type it could not have created — see the orphan hazard below for what that used
to do.

**Orphan hazard.** A config row whose `view.type` references a renamed/removed
view-type (or a hierarchical type when the source has no hierarchy) **fail-soft
skips** in `buildInstanceFromRow` — the same documented hazard as reorder
node-type ids. The row stays in the config; it just isn't rendered until its
view-type returns.

That skip is only safe while nothing the USER can click puts a row into it. It
did not used to be: the settings popover's type picker listed every registered
view-type regardless of source, so picking Tree on a flat surface wrote a row the
resolver then dropped — the view vanished from the switcher, looking for all the
world like a delete, while its row (name, sort, filter) sat untouched on disk. The
gate now shared with the add menu is what keeps the skip reachable only by an
authoring mistake, never by a click.

## Multi-source surfaces (`MergedDataView`)

One surface, N **sources**, one unified switcher: `<MergedDataView storageKey
sources hostProps title? actions? defaultView?>` renders a single DataView
surface (**one `storageKey` → one config file → one `EditableViewSwitcher`**)
whose view-instances each bind to a source via the config row's optional
`source` key (`{ "id": "queue", "name": "Queue", "source": "queue", "view":
{ "type": "list" } }`). The sort/filter/search/properties chrome adapts
automatically because it already derives from the active instance's fields —
the source axis only decides *which data bundle* feeds the body.

- **Sources are contributed components** through the per-consumer
  `defineDataViewSources<THostProps>(id)` factory (web barrel — the sibling of
  `defineItemActions`/`defineFieldExtensions`). A contribution is `{ id, title,
  icon, order?, views?, hasHierarchy?, component }`; the component receives
  `DataViewSourceProps<THostProps>` = `{ hostProps, render }`, owns its data
  hooks, and **must always call `render(bundle)`** — pass `{ rows: [], loading:
  true, … }` while loading; an early `return null` makes the surface chrome
  vanish. The bundle is `DataViewSourceBundle<TRow>` = `DataViewProps` minus
  the shell-owned keys (`storageKey`/`title`/`actions`/`defaultView`/`views`).
- **`views` / `hasHierarchy` are STATIC contribution metadata**, not bundle
  keys, on purpose: the view model must resolve *every* config row (switcher
  chips, add-menu gating, the hierarchical gate) before any source component
  mounts — and only the ACTIVE source ever mounts. Everything dynamic (rows,
  fields, the actual `hierarchy` accessors, `viewOptions`, `source`, …)
  stays in the bundle; the host dev-warns when a bundle's `hierarchy` presence
  contradicts the declared `hasHierarchy`. Code-only `viewOptions`
  (`renderRow`, `renderBody`, …) reach the view through the body's options
  re-merge (`{ ...bundle.viewOptions[type], ...instance.options }` — idempotent
  on the single-source path).
- **Only the active source mounts** (plain `renderIsolated`, no recursive
  fold); switching sources remounts the body (`key={source.id}`), so
  per-source subscriptions/controllers restart cleanly.
- **Fail-soft on unknown sources.** A row whose `source` matches no live
  contribution (renamed/removed source id) is kept in config and skipped —
  the same hazard class as an orphan `view.type`.
- **Instance ids must be unique ACROSS sources** (one config file = one id
  namespace). `normalizeRows` would disambiguate a duplicate with an index
  suffix, silently renaming the row and orphaning its durable
  `data_view_row_order` rows — author distinct ids per row, as
  `config-stable-list-ids` already forces.
- **Presets stay per-surface and fail-soft by design.** Sort/filter presets
  key off `storageKey` only, so they are shared across sources; a preset
  referencing a field the active source's schema lacks is simply excluded by
  the controllers' dangling-fieldId guards. Do not namespace them per source.
- Single-source `<DataView>` is the same machinery with **one implicit source
  entry** (`id`/`title` undefined): same model, flat add menu, `source`-less
  config rows — byte-identical to the pre-source behavior. The engine-side
  semantics (row model, `ViewSourceEntry`, whitelist-gates-addability) live in
  view-core — see its CLAUDE.md.

## Hierarchy

A data source can declare itself hierarchical by passing `hierarchy` (a
`HierarchyConfig<TRow>`) to `<DataView>`. Present → hierarchical views (the
tree) become selectable; absent → the host drops them from the switcher.
`hierarchy` and `paging` are exclusive on the in-memory origin (a type union,
both keys optional): a tree over a paged prefix orphans the children whose
parents are not loaded — the same reason a live `source` refuses `hierarchy`. The
`HierarchyConfig` carries two required accessors (`getParentId`, `getRank`), the
optional reference-edge accessor (`getAliasParents`, below), and the optional
mutations (`onMove`, `onCreate`) — so a read-only nav tree supplies just the two
required accessors.

**Expand is not one of them, and never can be.** There is no
`isExpanded`/`onToggleExpanded` pair: collapse is always the primitive's own
per-`(surface, view-instance, row)` map (see "State split" above), which makes
the anti-pattern documented there unrepresentable rather than merely
discouraged. It also retires the half-wired state the pair admitted — the two
were independently optional, so supplying one gave a chevron whose write went to
the view map and whose read came off the row: a silently dead toggle no check
could catch. The "click a folder to open it" affordance that motivated a
consumer-side accessor is now the **stateless** `expandOnActivate` predicate on
the tree view's `options` (see the tree child's CLAUDE.md); carrying no state,
it cannot be half-wired.

The `FieldDef.primary` flag selects the tree row label field (shared
`pickPrimaryField` heuristic). Inline rename of the primary label is no longer a
hierarchy concern — declare `FieldDef.onEdit` on the primary field and the tree
renders an inline editor (the same `onEdit` contract the table/gallery/list use).

### Leading field

`FieldDef.leading: true` marks the row's **leading visual** (its avatar). list,
gallery and tree render that field's cell in their leading slot — `Row.icon`,
`DataCard.leading`, `RowChrome.icon` — and icons draws it as the whole tile
(inside `AvatarPresentationProvider value="tile"`); all leave it out of the body: never the
title / label pick, never a list subtitle or trailing term, a gallery property
row, or a tree secondary chip. The gallery's **cover is untouched**; the cover
stays media. The **table** has no leading slot, so there it is an ordinary
column.

- **Composition, not replacement.** The field renders **first**, then the view's
  own per-view option (list/gallery `leading`, tree `leadingIcon`) — most of
  those put a status glyph there, not an identity, and a surface can want both
  (avatar, then status dot). One shared `leadingSlot(...)` (web barrel) renders
  the pair for all three views, so the order cannot drift; it returns
  `undefined` when there is neither, so a host slot still sees "no icon".
- **Resolved from the visible set.** Each view calls `pickLeadingField` over the
  same `resolveBodyFields(...)` result it already renders from, so hiding the
  field in Properties hides the avatar.
- **At most one per schema.** `pickLeadingField` throws when two fields declare
  it. There is no type-based fallback: data-view names no field type, so only
  the flag qualifies.

Beyond the single-parent tree, `getAliasParents` declares optional **reference
edges**: the row *also* appears as a read-only leaf ("alias") under each
returned parent id (e.g. the pages sidebar rendering linked pages as children
of the linking page). Aliases are pure references — navigation only, no
rename/menu/actions/drag; a `child` drop or add-child on one resolves to the
real row. See the tree view child's CLAUDE.md for the exact semantics.

## Manual order

Flat rank-based drag reordering — the flat twin of the tree-only
`HierarchyConfig`. It is described by one type:

```ts
interface ManualOrderConfig<TRow> {
  getRank: (row: TRow) => Rank | null;
  // within one section
  onMove: (id: string, dest: {
    rank: Rank; targetId?: string; zone?: "before" | "after";
  }) => void | Promise<void>;
  // across sections — group write + reorder; absent ⇒ such drops are refused
  onReseat?: (id: string, dest: {
    groupKey: string | null; targetId: string; zone: "before" | "after";
  }) => void | Promise<void>;
}
```

### Two sources, one rule

A `ManualOrderConfig` reaches the active view from exactly one of two places:

1. **`DataViewProps.manualOrder`** — a **domain** order the consumer owns (a rank
   column on its own rows, e.g. the conversations queue's priority). Surface-wide:
   every view instance shares it.
2. **The primitive's own per-view-instance order**, contributed through the global
   **`DataViewSlots.RowOrder`** slot (see below). Scoped to `(storageKey, viewId)`,
   so two instances of the same surface hold **different** orders.

**The consumer's wins when both are present.** The host resolves
`cfg = props.manualOrder ?? contributedRowOrder ?? null` once and never branches on
provenance again — the render path treats the two identically.

### Manual order is the default; a sort overrides it

Notion's model, and ours: with **no sort set**, a `list`/`table` view renders in
manual order and rows are draggable; setting a **field sort overrides** it and
suspends drag (the host simply withholds the config; `useDataViewSections`'s
`manualRank ⇒ sort: []` rule is untouched); **clearing the sort restores** it.
Consequently the **Sort control stays visible** in manual mode — it must stay
reachable to clear the sort. It is also the *only* remaining thing that suspends
drag, so the sort popover says so in a muted footer line whenever an order exists
and a sort is shadowing it (`manualOrderOverridden`) — the cause is never silent.

When a config is active for the displayed view:

- the section pipeline **skips the field sort** and orders each section's entries
  by `getRank` (search/filter still run) — like the tree ignores `ViewState.sort`;
- rows are sortable via the **`rank-reorder`** primitive (`RankReorderProvider`
  + `useRankSortableItem`): the dragged row itself follows the pointer
  (`CSS.Translate`, no floating chip, no drop-indicator lines) and the rows of
  its section slide out of its way. `icons` passes `layout="grid"`;
- reordering is **within a section** (`onMove`). A cross-section drop needs the
  group-by field written, which only the consumer can do, so it is a separate
  capability expressed by **handler presence**: with `onReseat` the drop is
  allowed and reported anchor-only (`{ groupKey, targetId, zone }`); without it
  the provider's collision detection only sees the dragged row's own section, so
  the drag can neither slide nor land elsewhere — the refusal is **visible**
  rather than a drop-time no-op (see `rank-reorder`'s CLAUDE.md);
- **no snap-back on drop.** dnd-kit clears the slide transforms the moment the
  row is released, so `data-view-body` wraps the effective config through
  `usePendingMoveOverlay` (`web/internal/use-pending-move-overlay.ts`): `onMove`
  records the destination rank and `getRank` returns it for that row until the
  underlying `getRank` changes (the producer's optimistic or server order
  landed), the row disappears, or a returned `onMove` promise rejects. A
  producer only needs to return its mutation promise from `onMove`;
- `list`, `icons` and `table` **window *and* drag**. `rank-reorder` re-measures
  droppables every frame (`measuringAlways`), `virtual-rows` pins the drag
  source through `keepMounted`, and `raisedKey` lifts the dragged row's
  windowed wrapper (its own stacking context) over the rows it crosses — so an
  in-flight drag survives its source row scrolling out.

The table integration uses `DataTable`'s additive `useRowDecoration` per-row hook
seam (drag source ref + props + the sortable `style`), composed with the
windowing measure ref. Windowed table rows use spacers, not transforms, so the
row's own slide transform leaves the subgrid tracks alone.

### The global `RowOrder` slot (cross-plugin)

The sibling of the global `FieldExtension` slot: a single always-on
`defineRenderSlot` (`primitives.data-view.row-order`) whose contributors may claim
a per-view-instance row order for **any** DataView, with the host importing
nothing. Its props erase the row type (a global slot spans disjoint consumer row
types) and carry the surface coordinates a contributor needs:

```ts
interface GlobalRowOrderProps {
  storageKey: DataViewId;
  viewId: string;                  // the ACTIVE view-instance id — the order's scope
  rowKey: (row: unknown, index: number) => string;
  rows: readonly unknown[];        // the ordered set (below)
  render: (order: ManualOrderConfig<unknown> | null) => ReactNode;
}
```

The host folds it in `CollectRowOrder` (`web/internal/row-order.tsx`) — the same
recursive-component fold as `CollectFieldExtensions` (see Field extensions), but
resolving a single `ManualOrderConfig | null` on a **first-non-null-wins** rule
instead of accumulating a `FieldDef[]`, and *gated* rather than unconditional. Each
contributor mounts error-boundary-isolated (`renderIsolated`), runs its own hooks,
and hands back a config (or `null` to abstain) through `render`. Because the slot
is a `defineRenderSlot`, that precedence is a committed reorder override
(`config/primitives/data-view/primitives.data-view.row-order.jsonc`), not an
import-order accident.

**`rows` is the view's ordered set: filter-applied, search-EXCLUDED,
sort-suppressed** — computed with
`useFlatRows(effectiveRows, fields, { ...activeState, sort: [], query: "" }, …)`.
Rows the view filters out never receive a rank. Search only changes what is
*rendered*, never which rows the order covers, so a drag under an active search
still resolves against the full ordered set. The contributor nonetheless persists
only a bounded write set per gesture — see view-order's CLAUDE.md.

### The `rowOrderEnabled` gate

`CollectRowOrder` takes an `enabled` prop and short-circuits **before**
`useContributions()` when false — so an ineligible DataView never mounts a
contributor and never subscribes to its live resource. Each clause is a structural
exclusion, not a preference:

```ts
const rowOrderEnabled =
  activeSupportsManualOrder &&   // list / table only — gallery/tree have no flat rank axis
  manualOrder == null &&         // a consumer's domain order wins
  props.source == null &&        // a live source is server-sorted ⇒ the client cannot own the order
  aggregate == null;             // an aggregate representative's rank cannot stand for its members
```

**Group-by is deliberately absent too.** It used to be a clause, which is what
made drag silently stop working under the Pages sidebar's default `groupBy`.
Within-section reordering is well-defined — the contributed order covers the
whole *unpartitioned* set (`CollectRowOrder` feeds it filter-applied,
search-excluded rows), so a drop anchored on a same-section neighbour resolves
globally — and the one unsupported case, a drop into another section, is refused
per-drop by the view (above), not by suspending the whole order.

**The sort test is deliberately absent here.** It lives in `manualOrderActive`
(`cfg != null && activeSupportsManualOrder && activeState.sort.length === 0`)
instead, so toggling a sort off and on does not tear down the contributor's live
subscription — the host merely withholds the config while a sort is set.

## Grouping is a field-type contribution

**data-view names no field type.** How a field's values partition into sections
is declared by the field's own TYPE, through `DataViewSlots.Grouping` — the
sibling of `Cell` / `CellEditor` / `Filter` / `ValueCodec` / `ColumnConfig`, and
the same shape: a plain `defineSlot` payload keyed by `match` (the type token),
resolved per type honoring the `extends` chain.

```ts
DataViewSlots.Grouping({
  match: "date",
  label: "Group dates by",          // the granularity band's own section label
  groupings: dateGroupings,          // Smart, Day, Week, Month, Year
});
```

The primitive used to spell `type === "enum" || type === "bool"` in three
places — `isGroupableField`, a `sectionLabel` with an enum-options lookup and a
`bool → Yes/No` branch, and an "enum sections follow `field.options` order"
block inside `partitionIntoSections`. A date field could not group at all
(`String(aDate)` puts every row in its own section), and adding one would have
meant a fourth branch. Now enum, bool and date each contribute their own
groupings and the partition is pure mechanism.

### The contract (`core/internal/grouping.ts`)

```ts
interface FieldGrouping {
  id: string;                       // "smart" | "day" | "value" — persisted
  label: string;                    // "Smart", "Day", "Value"
  plan: (ctx: GroupingPlanContext) => (value: FieldValue) => GroupBucket | null;
}
interface GroupingPlanContext { now: number; values: readonly FieldValue[]; field: FieldDef<unknown> }
interface GroupBucket { key: string; label: string; order: number }
interface GroupByRule { fieldId: string; groupingId: string }
```

Three things about it are load-bearing:

- **`plan` is two-phase.** A grouping that must see the whole set before it can
  order its sections (enum by `options` index, the identity fallback by value
  order, a future range-derived "Auto") does that work once per render, not once
  per row.
- **`now` is injected, never read.** A grouping calling `Date.now()` would be
  untestable (the precedent is `relativeDayLabel(date, now)`) *and* incorrect
  here: the partition runs inside a `useMemo`, so a live clock would change the
  memo key every render. The host reads it once per surface via
  `useGroupingClock()` — local midnight, quantized, re-armed by ONE `setTimeout`
  at the next local midnight so a view left open overnight stops saying "Today".
  That timer is not the banned polling: it fires at the instant the value
  changes, which the calendar knows in advance, rather than waking to check.
- **`order` is a plain ascending ordinal**, read from whichever end the view's
  own sort on the grouped field points (`DataViewRenderProps.groupOrder`) — so
  `startsAt asc` reads Today → Tomorrow → Later and `startsAt desc` reads newest
  month first, out of one ordinal with no second config axis. The host derives
  it from **`activeState.sort`**, not the view's `state.sort`, which a
  live source zeroes out. The `None` bucket holds no position on the
  ordinal, so it stays **last in both directions**.

### There is exactly one "None", and a grouping cannot mint a second

A bucketer returns `GroupBucket | null`. **`null` means "not a value I can
bucket"** — a string in a date field that does not parse, an enum value of the
wrong shape — and the row joins the SAME section as a null value: one "None",
ordered last in both directions, owned by the partition.

A grouping must never build its own catch-all, and the type is what stops it.
The date grouping originally returned a `NO_DATE` bucket keyed `"none"` with
`order: Number.POSITIVE_INFINITY`, which fails twice: a second section also
labelled "None" appears beside the real one, and `Infinity - n` is `Infinity`, so
the catch-all pins last ascending and **first descending** — it jumps to the top
of the list the moment the view's sort flips. `null` has neither failure mode
available.

The ordinal is checked too: `order` must be **finite**, or the partition throws
naming the grouping and the bucket (once per bucket, not per row). Infinity is
only ever reached for as "put this at the end", which it does not do; that is
what `null` is for.

### Groupability is derived, not listed

`isGroupableField(field, hasGrouping)` is `field.groupable ?? hasGrouping(type)`
— a field is groupable because its type says how it buckets. `hasGrouping` comes
from `useGroupingRegistry().has`; the host resolves it once and publishes it on
the controls context, because a `Setting` contribution's `isApplicable` is a pure
function and cannot read a slot. Any field can still opt out with
`groupable: false`, or in with `groupable: true` — which then uses the fallback:

**The identity grouping** (`web/internal/identity-grouping.ts`,
`{ id: "value", label: "Value" }`) is what a type declaring no groupings falls
back to: one section per distinct value, `String(value)` for both key and label,
ordered by the value's index in the `compareValues`-sorted value list. It is also
what the legacy persisted `groupBy: "<fieldId>"` string migrates to —
`readGroupBy` coerces it to `{ fieldId, groupingId: "value" }`, which is exactly
what that string always meant. Migration is **on read and never destructive**;
the config row is re-serialized only when the user next edits group-by. No
committed `.jsonc` needs touching.

### The picker

`GroupByControl` renders the field radio band, then — only when the active
field's type offers more than one grouping — a **second `ControlPanel.Section`
labelled from the contribution's own `label`**. Two bands rather than a
`usePanelStack` push (the `add-sort-affordance.tsx` precedent): the choice is
small and closed, and seeing granularity next to field is the point. Picking a
field goes through `controller.setField`, which resolves the granularity itself
(keeping the current one when the new type still offers it, else that type's
first), so the persisted `groupingId` is never one the type does not have.

## Grouped sections: one pipeline, one chrome

`useDataViewSections` computes the sections; **`<GroupedSections>`** (web barrel)
presents them. They are deliberate siblings: a view child's grouped branch renders
*through* the chrome rather than hand-rolling it.

```tsx
sections.length === 1 && sections[0]!.key === null ? (
  renderBody(sections[0]!.entries)          // ungrouped: headerless fast-path
) : (
  <GroupedSections
    sections={sections}
    collapsedSections={props.collapsedSections}
    setSectionCollapsed={props.setSectionCollapsed}
    headerStyle={props.groupHeaders}
  >
    {(section) => renderBody(section.entries)}
  </GroupedSections>
)
```

It owns the whole group-header policy: the shared `<Stack gap="none">` sticky
containing block, the `<StickyStack>` pinned at the host-published
`--dv-header-offset`, the DOM-less `<CollapsibleProvider>` per section, and the
`SectionHeaderRow` (label + count). So group headers **pin, and stack up to 5
groups, degrading to the swap hand-off above that** — in every view, for free.
There is **no per-view header-inset axis**: `GroupedSections` owns `rail-follow`
on its `SectionHeaderRow`, so every group header sits on the one rail (see "The
rail" below) — no view passes a `headerClassName`.

### `groupHeaders` — standard or quiet headers, per surface

`DataViewProps.groupHeaders?: "standard" | "quiet"` is a surface declaration like
`density`: `DataView` / `MergedDataView` hand it to `DataViewShellFrame`, it
rides `DataViewShellChrome`, and the body threads it into
`DataViewRenderProps.groupHeaders`, which every `GroupedSections` view passes as
`headerStyle`.

- **`"standard"`** (default) — chevron first, the count at the far right. An
  absent value renders the exact node it always did (pinned by
  `web/__tests__/grouped-sections.test.tsx`), so no surface changes unless it
  asks.
- **`"quiet"`** — one run: the semibold label, then its count right beside it
  ("Queue 6", faint semibold), with the fold chevron trailing that run and
  shown only on hover or keyboard focus (`SectionHeaderRow
  disclosure="trailing"`). For a narrow list whose headers should read as
  captions over the rows (the agent-manager conversation sidebar).
  `headerActions` stay in the trailing cluster. Its label sits on the rows'
  **text** column, not their pill edge: the sticky band pays the rail
  (`rail-follow` on the `StickyStackItem`) and the header row keeps its own
  `p-row`, like a body row. (A standard header puts `rail-follow` on the row
  itself, which replaces the row's inline pad, so its label sits on the pill
  edge — one row pad left of the row text.) The list view also drops the
  section body's top padding under a quiet header, so the rows start right
  under their caption.

list, gallery, tree and icons honour it through `GroupedSections`, and so does
the **table**: it composes its own `col-span-full` header rows inside
`data-table`, but the node in them is the same `DataViewGroupHeader` (exported
from the web barrel) that `GroupedSections` renders — one rendering of either
treatment, so the table cannot drift from the flat views. See "Table view
options" below.

### `headerActions` — one affordance, scoped to one section

`headerActions?: (section) => ReactNode` renders beside the count (the tree's
fold-this-group toggle today). Return `null` for a section with nothing to
offer — the wrapper is then skipped too, so a view passing no `headerActions`
(list, gallery) draws the node it always did.

Count and action want opposite treatments, so they are **two** clusters: the
count reads at rest on the header's own `actionsAlwaysVisible` cluster, the
action sits in a nested `<RowActions pin={null}>` and reveals on hover
(`RowActionsProps` separates `pin` from `alwaysVisible`; the nested cluster
rides the `group/row-actions` `Row` publishes unconditionally). `gap="xs"`
between them is load-bearing — nothing has ever sat beside the count.

No click guard is needed even though the header is the collapse trigger:
`RowActions`' button `Stack` already stops `onClick` and `onPointerDown`. And
**not** the `hover-reveal` primitive — its own CLAUDE.md says a row-action
cluster is `row-actions`' job, and the two together compete.

**Why it is shared and not per-view.** Per-view JSX drifts (a view child silently
forgetting to pin its headers), and a lint rule can't state "a grouped section must
be wrapped in sticky chrome" — one shared branch makes the divergence
unrepresentable. See
`research/2026-07-17-data-view-gallery-sticky-group-headers.md`.

**`table` is the documented exception.** Its group headers are `col-span-full` rows
of `data-table`'s subgrid — chrome that owned a `<Stack>` would displace them out of
the grid and break column alignment — so it composes `StickyStack` directly inside
`data-table`, under the same policy and with `base` offset by its own sticky column
header (or by nothing, under `columnHeader: "first-group"`, which has no header
row). The tree renders through the shared chrome too, with one `TreeList` per
section: its ROOTS partition by the group-by field and every descendant follows
its root's section (see the tree child's CLAUDE.md "Group-by"). It is the one
view that calls `partitionIntoSections` directly rather than through
`useDataViewSections`, so it resolves the grouping registry itself.

## Aggregating sections (`aggregate`)

Pass `aggregate?: DataViewAggregateConfig<TRow>` to `<DataView>` to collapse rows
sharing a key into a single **representative row + count badge**:

```ts
interface DataViewAggregateConfig<TRow> {
  getKey: (row: TRow) => string | null;            // null = standalone, never collapsed
  pickRepresentative?: (members: readonly TRow[]) => TRow;  // default: first in current order
}
```

It is a **pure pipeline transform**, orthogonal to the `supports*` flags — the
host threads it to every flat view (`list`/`table`/`gallery`), each running it
through `useDataViewSections`. The aggregate step runs **after** group-by and
**after** the manual-order rank sort, **within each section**:

- entries sharing a non-null `getKey` collapse into ONE `DataViewRowEntry` with
  `row = pickRepresentative(members)`, `aggregateCount = members.length`, and
  `members` = every collapsed row, keeping the **position and `key` of the first
  member** (the entry stands for the group, not a single row);
- a `null` key passes the row through 1:1 (no `aggregateCount`);
- `section.count` becomes the **post-collapse** entry count (an aggregate counts
  once, so the header matches the rows shown; a lower bound stays a lower bound).

Each view renders the representative normally and, when `entry.aggregateCount > 1`,
a `×N` `Badge` (`css/badge`) in its natural trailing spot — list **trailing**,
table **in the primary cell** (keyed by row identity, since the cell renderer
gets no index), gallery **top-left card corner** (a `Pin`, clear of the
hover-revealed top-right actions).

**"Acting on the representative acts on the group" is the consumer's concern.**
The representative is a real `TRow`, so `onRowActivate`, `itemActions`, and
`manualOrder.onMove` already fire on it; mapping that to a group mutation (e.g.
reseating every member) is the consumer's job. The primitive owns only the visual
collapse + representative selection + count badge.

## Fold: "… N more" per section (`ViewState.fold`)

A **softer filter**: a filter removes rows, a fold keeps them counted and one
click away. A view's fold rule is `{ keep: FilterGroup }` (`FoldRule`, core),
persisted in the view config row beside `filter`/`groupBy` (`readFold` /
`setFold` in `use-data-view-model.ts`, merge-written, key omitted when cleared or
empty). Rows NOT matching `keep` are pulled out of their section and replaced by
one **fold line** at its end — `… N more`, or `Show less` while open. `keep` is
the ordinary filter language, so every field type's operators, the filter
editor, `summarizeFilter` and the persistence format are shared with `filter`.

```jsonc
"view": { "type": "list", "groupBy": "section", "fold": { "keep": {
  "kind": "group", "id": "keep", "conjunction": "or", "children": [
    { "kind": "rule", "id": "recent", "fieldId": "updatedAt", "operatorId": "is-within-past", "value": { "amount": 30, "unit": "day" } }
  ] } } }
```

The rules, each enforced in exactly one place:

1. **Search suspends folding** — `effectiveFold(state)` (`web/internal/fold-sections.ts`)
   drops the rule while `query.trim()` is non-empty; a match never hides behind "…".
2. **The selected row is never folded** — `makeFoldKeep` keeps `selectedRowId`
   (or an aggregate entry holding it as a member).
3. **A group whose rows are all folded still renders** — header, then the fold
   line only. Partition runs before the fold, so the section exists.
4. **Folded rows are pulled from wherever they sort**; the line always sits at the
   end, and opening it re-inserts them in sorted order.
5. **Open state is ephemeral** — in memory in `DataViewBodyInner`, keyed by the
   active view id; a view switch or reload re-closes every fold. Never config.
6. **Paging stops behind a folded tail** — while a fold is in effect, none is
   open and the paged read's tail is folded (`isTailFolded`), the body gates
   the scroll observer's own `hasNextPage` (see *Paging* below). It is a gate,
   not a hidden footer: unmounting the sentinel behind the observer's back
   would never re-observe it and paging would stall silently. Opening any fold
   lifts the hold.
7. **The fold runs last** — after partition, manual order and aggregation
   (`foldSections` in `useDataViewSections`), so an aggregate's representative
   decides. `section.count` stays the total; `section.fold = { hidden, open }` is
   present only when ≥1 entry fails `keep`.

**A section's body band draws its fold line.** The host hands views
`DataViewRenderProps.foldLines` (`{ open, setOpen, summary }`, present exactly
when a fold is in effect). A view passes `foldLines.open` + `selectedRowId` to
`useDataViewSections`, and renders each section's entries inside
`<SectionBody section foldLines className>` (web barrel) — the ONE box that pays
the rail for that section's content, ending in the section's fold line. There is
no separate `FoldLine` to place (it is not exported), so a view cannot forget it
or put it on a different edge than its entries: the line is a plain `Row` in the
same band, landing on the list rows' text column or the gallery cards' edge
alike. Its content must not `rail-follow` again (the band paid). In the grouped
path the view returns its `SectionBody` from `GroupedSections`' `children`
(inside the collapsible content, so a collapsed group hides it too); the table
puts a `SectionBody` holding only the line in `DataTable`'s full-span `footer` /
`DataTableGroup.footer` row. The **tree** declares `supportsFold: false`: the
host applies no fold to it and hides the setting.

**The editor** is the "Fold rows" `view`-scope `Setting` (`fold-control.tsx`):
the rule in words plus Clear, and the filter builder pushed as a page and pointed
at `fold.keep` by `FoldFilterScope` — a nested `DataViewControlsProvider`
overriding only `filter`. Filter presets are off there (they belong to the view's
filter). Because a pushed page replaces the root's subtree, the builder pushes
its own sub-pages through `useFilterPanelStack()` (`filter-scope.tsx`), which
re-enters the current scope component around the page — otherwise a nested
group opened from the fold editor would edit the view's filter instead.

"Fold line" / "folded rows" is unrelated to the tree's fold-children header
action (which collapses subtrees).

## Paging (`paging`)

A live `source` pages its own read. A consumer that must derive its rows in
memory from a paged read — the conversation Queue, whose Done section is the
`conversations-gone` pages merged with ranked/active rows — passes
`paging={…}` beside `rows` (`DataViewPaging`; `useLivePagesPaging(c, query,
{ resetKey? })` reads the collection as live pages — `network/live`'s
`useLive(c, query, { viewport, resetKey })`, with the viewport it mints — and
hands back the read and its paging together). Both reach the body as one
`paging`, so the footer (loading-more, Retry, the stop line), the notices, the
hold and the viewport are one code path. It takes a collection's window (any:
every window pages; a lookup-only or `all` collection is a tsc error): a
key-range-paged `liveValue` reads through the same `useLive` pages, but a
DataView source over one needs the filterable and text-column seams a value
does not have (task-1791593959-9liyj7).

```ts
const { pages, paging } = useLivePagesPaging(conversationsGone, {}); // data-view web
// pages: network/live's LivePagesResult; paging: null until it is ready
<DataView rows={rows} paging={paging === null ? undefined : { ...paging, isPaged }} … />
```

- **The viewport (`paging.viewport`, required).** The body measures which rows
  it has on screen and reports each paged read's share to its sink, in the
  read's own order (`DataViewVisibleRows`: the first and last of its rows on
  screen, or `none`); the internal `usePagesViewport` turns the reports into
  the branded `VisibleRange` `useLive` keeps its pages live by — the only
  place one is minted (`live/visible-range-minter` lint; data-view's
  sanctioned exemption). `useLivePagesPaging` mints the viewport and the
  paging together, so a read cannot page by a viewport nothing measures: hand
  its `paging` to the DataView drawing the rows. A read that pages by no
  viewport passes a sink that discards the report (internal `NO_VIEWPORT`).
  - **One measurement per DataView** (`web/internal/use-visible-row-keys.ts`):
    every view marks each row it draws with `data-row-key` (the row key — list
    `Row` / tree-chrome rows, the tree view's `RowChrome` (an alias carries
    none: the real row marks it), gallery `DataCard`, the table's rows, icons'
    tiles), and one IntersectionObserver (the `in-view` primitive) watches them
    inside the body's box (`KeepAnchorAcross`'s). A MutationObserver only ENROLLS
    rows a view mounts later (a windowed list); the observer's entries — one
    per row it is handed, then one per crossing — drive the settle. The set is
    published after the rows on screen hold still for 250 ms (`SETTLE_MS`), so
    a fling does not subscribe every page it crosses, and at most 1 s
    (`MAX_WAIT_MS`) after the first change it has not published, so a list
    whose rows never hold still (a busy feed) still updates its viewport.
  - **A measurement vouches only for the rows it saw.** The body keys it by an
    EPOCH — the keys of every read's rows — and `useVisibleRowKeys` is
    `measuring` for a new epoch until a settle that ran after its rows were
    committed (re-armed in the commit). A settle waits while a row it enrolled
    has had no entry yet, and with no `[data-row-key]` element drawn at all it
    stays `measuring` — never an empty set. So a head that lands after the
    skeleton was measured, or a new query's head, is never reported off screen
    by the rows it replaced (which would release it the moment it landed). A
    view type that forgets the marker therefore releases nothing (its pages
    stay live, never stale) — still, **a new view type must stamp
    `data-row-key` on its rows**, or its pages are never released.
  - **Split per read.** A flat origin's paging gets the rows `isPaged` names
    (all of them, absent); each declared section's paging gets its own
    section's rows. A folded row, a collapsed section and a section scrolled
    away are not on screen, so their pages release.

- **Placeholders (`paging.placeholders`, required).** A paged read's pages
  past its stale budget (`network/live`, *Paged reads*) are
  `{ before, after }` lists of `DataViewPagePlaceholder` (`{ key, rows }`) —
  never rows, never between two rows. The body draws them
  (`web/components/page-placeholders.tsx`): one element per page, through
  `primitives/loading`'s block, carrying its `key` as
  `data-row-key` (and `data-page-placeholder`) so the viewport measures it
  like a row and reports it in the read's order — a placeholder on screen
  subscribes its page again, and its rows replace it.
  - **Where.** A flat read's around the whole view — only when every row of
    the view is the read's: with `isPaged` the read's rows sit among others'
    (the Queue's Done section), so none is drawn and its far pages simply
    leave the screen until the read's first or last drawn page nears the
    viewport (anchored: see *Anchoring*). A declared section's inside its
    band (`SectionBody`: `before` above the entries, `after` below them; with
    no entries in the band — all folded, or the table drawing its rows in its
    grid — only `after`).
  - **Height: exactly the room its rows took** (`web/internal/placeholder-heights.ts`,
    `usePlaceholderHeights`, provided as `PlaceholderHeightContext`). Each
    settle also records every drawn row's ADVANCE (`useVisibleRowKeys`: its
    top to the next entry of its read's top — a list row's height, a
    gallery line's height on its last card and 0 on the others), kept for
    every row still in the reads, drawn or windowed out. A placeholder is
    sized once, in the render it appears in, from what it replaced: the
    previous layout's entries between its surviving neighbours, at their
    advances (several new placeholders between the same neighbours share
    them row for row). So releasing a page changes no layout at all — the
    invariant; nothing has to be anchored. A row never measured counts at
    the mean advance (`rowPitch`), as does a placeholder with nothing
    measured to replace; a standing placeholder keeps its height whatever
    the pitch does since.
  - **Anchoring** — the residue. Rows landing back may differ from their
    placeholder (they changed while away), and under `isPaged` nothing
    stands in at all; the body's rows box is `auto-scroll`'s
    `KeepAnchorAcross`, keyed by every read's placeholders (drawn or not),
    which keeps the first row on screen where it was (a placeholder only
    when no row is visible). Its box opts out of browser scroll anchoring
    (`overflow-anchor: none`): measured on the virtualized table, the
    browser anchored on a box the window was recycling and scrolled by a
    released page's height (+3100 px per release, no script write) —
    whole pages of rows never seen. `virtual-rows` re-measures its
    `scrollMargin` in the commit that changes its items, and a size it
    learns while the margin is stale scrolls nothing.
  - A paging that pages by no viewport passes the empty lists (internal
    `NO_PLACEHOLDERS`). Pinned by `web/__tests__/page-placeholders.test.tsx`
    (heights at the released rows' room, no scroll write on a release,
    anchoring on a landing that changed, none drawn under `isPaged` yet
    anchored, a live source scrolled deep keeping its drawn rows bounded
    with every row accounted for), `placeholder-heights.test.ts` (the
    sizing rules), each view's `paged-conformance.test.tsx` (list, table,
    gallery, icons — below) and, deployed, `e2e/live-pages-scroll.ts` (every row seen
    at `--step 0.4` / `0.8`, no row on screen moving on its own, no row
    changing its x; `--view <type>` picks the view by its switcher chip's
    `data-view-type`, `--scroller` / `--width` / `--expect-placeholders`
    for a sidebar list, a gallery's column count, and a run that must
    release).
  - **A grid keeps its columns.** A page released mid-line would restart
    the next card in column 0 and reflow everything below it. The flat
    read's placeholders reach the view as `DataViewRenderProps.placeholders`
    (present exactly when the body draws them; a declared section's are on
    `section.paging`), and a grid view keeps its band's phase through
    `useGridPhase` (web barrel): it records the absolute cell index each
    cell was drawn at and, while pages stand above the band, starts it with
    `index mod columns` empty spacer cells (no `data-row-key`), keyed by
    absolute line (`line:<n>@<columns>`) so a windowed line survives a
    release. The gallery and icons views use it; a stacked view needs
    nothing.

- **The conformance harness** (`web/testing`): `mountPagedDataView({ view,
  bundle, layout })` mounts ONE view through the real seam
  (`DataViewShellFrame` around `DataViewBody`, a fake one-instance model)
  inside a scroller the test drives, with an IntersectionObserver and
  `getBoundingClientRect` answering from a laid-out page — `"stack"` (rows one
  below the other) or `{ columns, linePx }` (a lane-aware grid: cells fill
  lines, `data-grid-pad` spacers take a cell, each grid element starts a line;
  the gallery's and icons' column probes are stubbed to `columns`).
  `describePagedConformance({ view, layout, windowAbove? })` is the contract
  every view runs in its own `paged-conformance.test.tsx`: a released page is
  one placeholder (`data-row-key` + `data-page-placeholder`, drawn as
  loading) exactly as tall as the room its rows took, a release writes no
  scroll, a landing that changed size is anchored; on a grid, a page ending
  mid-line keeps every card's column (plain and windowed) and a windowed
  release keeps the mounted lines' DOM. A new view type adds that one file.
  **Gap:** the grouped table draws no declared section's `before`
  placeholders (see the table's CLAUDE.md, "Paged").
- `isPaged(row)` names the rows the read supplies (absent: all). They sit in
  `rows` in the read's order, so the last one is the **tail**.
- **The next page loads only while the tail is on screen**: not folded (rule
  6 above), not in a collapsed section, and — in memory — not hidden by the
  view's search or filter — and not before any paged row is drawn (the
  consumer's other reads still loading). Otherwise a sentinel still in view
  would page the whole read in behind a collapsed header.
- Counts: until the read is `complete`, `rowsComplete` is `{ growable:
  isPaged, total }` — only a section holding a paged row can read as a lower
  bound ("30+"); the others stay exact. **Exact by default when cheap:** a
  read that knows its total passes `paging.total` (`DataViewPagingTotal`:
  `{ count, uniform? }`), and the section holding every loaded paged row
  counts its other rows plus `count` — ungrouped, or grouped by a field in
  `uniform` (one every row of the read shares, so the unloaded rows land in
  the same section: the queue's `section`). A live `source` reads it itself
  when its collection is declared `count: true` (`network/live`'s `:count`)
  and only the source's scope applies. The total is dropped — "N+" again —
  while the view's search or filter could hide rows of the read (a live
  source does not even read it then), while it is loading, and for a section
  the read's rows are split across.

## Create affordances (`creators`)

Pass `creators?: CreateOption[]` to `<DataView>` — typed "make a new row" actions,
the flat-view counterpart to the tree-only parent-scoped `HierarchyConfig.onCreate`.
`CreateOption` is domain-pure (`{ id, label, icon?, description?, onSelect }`;
`onSelect` may be async), exported from both the core and web barrels.

The host renders them in the toolbar immediately before the view switcher (a
private `CreatorsControl`, **not** barrel-exported): 0 → nothing; 1 → a labelled
`Button`; N → a `+` `IconButton` opening a dropdown of icon + label (+ muted
`description` sub-line) items. `CreatorsControl` owns a single shared **busy**
flag — each click `await`s `onSelect` in a `try/finally`, disabling the control
while pending, so no consumer hand-rolls a per-call-site `useState`. The creators
are also threaded into `DataViewRenderProps.creators` so views can opt into their
own create UI (the gallery's trailing "+" card + empty-state CTA).

`CreateOption.views?: string[]` names the view instances whose section header
offers the creator on a `sections` surface (absent ⇒ every section) — data, so
the host still builds the one `CreatorsControl`. Every other chrome has one
create affordance for the whole surface and ignores it.

## Toolbar arrangements

The toolbar's **parts** are the host's; their **layout** is an arrangement's.
`DataViewProps.toolbar?: ToolbarArrangement` (core) is a value the surface
imports and passes — absent, the host uses its own `barArrangement` (the inline
row every DataView has always had). The host never names or looks up an
arrangement, so adding one is a new plugin (e.g. `capsule-toolbar`) and no edit
here.

```ts
interface ToolbarArrangement {
  id: string;
  forms: { search: "field" | "bare"; controls: "ghost" | "round"; creators: "labelled" | "round" };
  component: ComponentType<ToolbarParts>;
  spaceBelow?: string; // CSS length between the band and the view; wide layout only
  overlay?: true;      // the band floats over the view — see "Floating chrome"
}
interface ToolbarParts {
  title; switcher: { strip; chip }; search; focusSearch(): void; query;
  controls; foldedControls; actions; creators;
  asideInset: string;  // how far the surface's `aside` reaches from the left edge
}
```

- **`forms` is data, so parts stay host-built.** The host builds each part once,
  in the form the arrangement asked for (`SearchInput appearance`,
  `ControlTrigger form`, `CreatorsControl form`); an arrangement places nodes and
  never re-instantiates one.
- **`switcher`** carries both forms — `EditableViewSwitcher` (`strip`) and
  `CollapsedViewSwitcher` (`chip`), built by the shell. Render exactly one; both
  are `null` on a pinned surface. It is the only way to add/rename/reorder views,
  so every arrangement renders one.
- **`search` is always rendered** — a non-empty query must stay visible.
  `focusSearch` focuses it (the capsule binds `/`).
  Its placeholder is the surface's (`DataViewProps.searchPlaceholder`, default
  `"Search…"`), never the arrangement's.
- **`foldedControls`** is every applicable control behind one always-visible
  trigger (no search): for an arrangement that runs out of room itself.
- **What the host keeps:** the `<Sticky>` band (`mask`, `layer="nav"`), its
  measurement and `--dv-header-offset`, `hoverRevealGroup` on the band, control
  applicability/order, and the **compact fold** — `density="compact"` or a band
  under `COMPACT_BREAKPOINT` renders the fold whatever arrangement was passed. An
  arrangement only chooses the wide layout, so none can break a narrow pane. The
  arrangement owns its own row box and inset (`rail-follow`).
- **`spaceBelow`** is the room an arrangement wants between itself and the view
  (the capsule floats apart from its content; the bar sits flush). The host
  renders it as a sibling AFTER the `<Sticky>` band, so it scrolls away with the
  content rather than growing the pinned band, and drops it in the compact fold.
  Views start flush — a view never pads its own top to make room for a toolbar.

### Floating chrome: `overlay` arrangements and the `aside`

For a surface whose view IS its canvas (a full-screen map with the tabs and
tools floating over it — `floating-toolbar` is the reference arrangement).

- **`ToolbarArrangement.overlay: true`.** The shell root fills its parent
  (`relative h-full`) instead of growing to its content; the body renders in a
  `Scroll fill isolate` of its own (the one exception to "never owns a
  scroller", since the band must not scroll away); the band is a `Pin
  to="top" stretch decorative` over it — transparent, `pointer-events: none`,
  no mask. The arrangement draws its parts as floating cards and wraps each in
  `Overlay.Interactive`, so the gaps stay click-through to the view.
  `spaceBelow` is ignored. The compact fold floats too, as the one bar on a
  floating card (`FloatingFold`), so the inset below means the same thing at
  every width.
- **`DataViewContribution.fullBleed`.** Under an overlay band a `fullBleed`
  view (a map) starts at the top-left edge, under the cards, in an `h-full`
  box. Any other view is inset by the band's measured height
  (`--dv-header-offset`, where its sticky group headers pin too) and the
  aside's reach, so its first row clears the cards. No effect beside an
  in-flow band.
- **`DataViewProps.aside?: ReactNode`** — a host panel (a facet sidebar) placed
  by `BandSurface` (`web/components/band-surface.tsx`): beside an overlay band
  a floating `Surface level="overlay"` card on the left (the panel sizes its own
  width AND height, capped at the surface's height minus `md` gutters; the card
  is a flex column, so a panel that scrolls its own body is a `<Column fill>`
  whose header and footer stay put; the rest of the span is click-through, so a
  panel folded to its header leaves the view below reachable), measured
  so the band's `asideInset` is `calc(md + width)`; beside an in-flow band a
  sticky left column, with `asideInset` `"0px"` (the band already starts past
  it). It renders inside a `DataViewControlsProvider`, so it reads and edits
  the active view through `useDataViewControls()` (`filter.setFilter(…)`, …).
  It is a surface key (carried on `DataViewShellChrome`, omitted from
  `DataViewSourceBundle`), shown once there is an active view, and only a band
  chrome takes it — a hosted or sections toolbar throws.

## Hosted toolbar: no band

`toolbar={{ kind: "hosted", frame }}` draws **no toolbar band at all**. For a
small, fixed list embedded in someone else's chrome (a card of live agents above
a prompt box), where search/filter/sort in a band of their own would be a strip
that mostly does nothing. The surface's `frame` component is its own header, and
the host hands it the parts to place (`HostedToolbarParts`,
`core/internal/toolbar-arrangement.ts`):

- **`options`** — the compact fold's one options trigger (`HostedOptions` →
  `CompactControls`): search on its first page, one row per applicable control,
  the same badge (controls + a non-empty query). It is the only way to reach the
  controls, so the frame renders it. Hover-revealed off the DataView **root**
  (the shell marks it `hoverRevealGroup` when hosted — there is no band to
  anchor on), pinned visible while a query is typed. The controls provider wraps
  this node alone, never the body.
- **`switcher`** — the collapsed switcher chip when the surface authors more than
  one view, else `null`.
- **`creators`** — `creators` in their compact form, or `null`.
- **`body`** — the rows. Loading and no-views states come through the same
  frame (`options`/`switcher` `null`), so the card never reflows as config
  settles.
- **`stickyRef`** — the shell's header-measurement ref. A frame whose header
  sticks attaches it to that sticky box, and the shell publishes its height as
  `--dv-header-offset`, so grouped views pin their section headers below the
  frame's header instead of under it. A card whose header scrolls away leaves it
  unattached.

`forms?: { switcher: "chip" | "row" }` picks the switcher's shape — data, like an
arrangement's `ToolbarPartForms`; the host still builds it. `chip` (default) is
the pill a card title wants; `row` is `CollapsedViewSwitcher appearance="row"`, a
full-width `Row` (the view's icon in the rows' lead column, its name, a chevron
shown on hover and while the menu is open) for a list that IS the surface, where
the switcher reads as the list's heading line. Same menu either way. The
conversation sidebar is the reference: `SIDEBAR_TOOLBAR` in
`conversations-view/plugins/data-view` — one sticky line
`[switcher (Fill)] [options]`, `stickyRef` on the `Sticky`.

It is **not an arrangement**: an arrangement lays out a band and must render the
switcher and search inline, and the compact fold ignores it. Hosted has no band,
so neither applies. `title` / `actions` are a **type error** beside it
(`DataViewSurfaceChrome` is a union): the frame is the header and renders its own.
No sticky band means no measured header offset — `--dv-header-offset` is `0px` —
unless the frame attaches `stickyRef` to a sticky header of its own.

Declare `frame` at module scope: it is a component, and a new identity per render
remounts the whole card. **Config is unchanged** — a hosted surface still has
its `defineDataView` id and authored config file like any other.

## Sections toolbar: every view at once

`toolbar={{ kind: "sections", forms? }}` renders EVERY authored view instance,
stacked in config order, each under its own collapsible header — a sidebar's
"Favorites / Private / Scratch" as one surface. There is no active instance and
no switcher. The Pages sidebar is the reference.

- **Shell.** `DataViewShellFrame` hands `renderSections(instances, …)` the whole
  list instead of calling its one-instance child; `DataView` renders
  `DataViewSectionsBody`, which hoists the field-extension fold above the
  sections (contributed fields subscribe once per surface) and mounts one
  `DataViewBodyInner` per instance, keyed by its id. The body needs nothing
  else: every controller in it is already keyed by view id through the
  id-parameterised `ReadyViewModel`. The model stays ONE hook in the shell —
  `useViewEphemeral` is a single `useState` over the whole map, so per-section
  models would overwrite each other's writes.
- **Header** (`web/components/view-section.tsx`, `ViewSection`): a
  `SectionHeaderRow` (`forms.header`: `eyebrow` default, or `group`) with the
  chevron trailing on hover, inside a DOM-less `CollapsibleProvider`. Its
  hover-revealed `RowActions` cluster holds `+` (the surface's `creators`
  narrowed by `CreateOption.views`) and `⋯` — a `ControlPanelPopover` whose
  first page is the compact fold's own (`CompactRootPanel`: search + one row per
  applicable control, under a `DataViewControlsProvider` for THAT view), then
  "Section settings" (view-core's `ViewSettingsPopover`: rename, type/options,
  duplicate, delete) and "Add section" (a page of the addable types). The
  cluster stays visible while the panel is open or a query narrows the view.
- **Sticky.** Each section is its own containing block, so its header pins
  while the section is on screen and hands off to the next one (not the
  accumulating `StickyStack` of group headers). Its body re-publishes
  `--dv-header-offset` as the header's measured height, so a grouped view's
  group headers pin under the section header. The shell's `stickyRef` is unused.
- **Collapse** is device-local: a view-level `collapsed` flag beside the view's
  expand map in `${storageKey}:view-state` — never a key in
  `collapsedSections`, which holds the view's group-by values.
- **`hideWhenEmpty`** (view row key): the body decides before the view mounts —
  hidden while its rows' `readiness` is loading (not-known-yet is never painted
  as an empty section, nor flashed in and out), hidden once ready with no row
  surviving the view's filter (the same `useRowFilter` predicate, under the
  same `filterScope` via the shared `scopeFilterRows` — "any root matches" for
  a roots-scoped tree), shown otherwise, a failed read included. A live
  source reports its own filtered rows.
- **`description`** (view row key): the header label's tooltip, and the first
  line of its `⋯` panel.
- **`selectedRowId` stays surface-level.** It highlights the row in EVERY
  section that shows it — a starred page is selected in Favorites and in the
  tree at once, as in Notion. **The reveal is not**: the sections body records
  which section a row was activated in (`beforeOpen`, so the record lands with
  the navigation), and every OTHER section gets
  `DataViewRenderProps.revealSelection: false` for that row — the tree neither
  expands to a favourite clicked above it nor scrolls the sidebar away from the
  click. A selection arriving from outside (a link, a deep link) still reveals
  everywhere; the tree's own clicks and arrow keys still reveal in the tree.
- `title` / `actions` / `pinnedView` are type errors beside it (no band; a
  pinned surface has one instance). `MergedDataView` takes
  `DataViewActiveChrome`, the union without this arm, so it cannot be spelled
  there: a merged surface mounts one source at a time. Section reorder is
  config order; drag-reordering sections is a follow-up.

## Toolbar controls

Every affordance in the toolbar that opens a panel — Filter, Sort, the view
settings — is a **`DataViewSlots.Control` contribution**. The toolbar names none
of them.

It used to name all three, as `sortControl` / `filterControl` / `fieldsControl`
ReactNode props built by the host: the collection-consumer rule broken in the most
literal way, and the reason no plugin could add a fourth control. Now the toolbar
reads the slot, drops the contributions whose `isApplicable` says no, sorts by
`order`, and builds one identical trigger per survivor.

```ts
DataViewSlots.Control({
  id: "data-view.filter",
  label: "Filter",              // tooltip + accessible name, compact-fold row
  icon: MdFilterList,           // label, and a pushed sub-panel's back title
  order: 0,
  size: "builder",              // the panel's WIDTH ROLE — menu | builder
  isApplicable: (ctx) => ctx.filter.filterableFields.length > 0,
  summary: (ctx) => summarizeFilter(…),   // pure; see below
  component: FilterControlPanel,           // prop-less; reads useDataViewControls()
});
```

### `defineSlot` + `renderIsolated`, not `defineRenderSlot`

The `View` / `Setting` precedent, for two reasons that are not stylistic:

- A render slot mounts **every** contribution. That would mount every control's
  panel on every DataView on every page — each running `useFilterPresets`, the
  live custom-values resource, and so on — merely to draw a **closed** trigger.
  With a plain slot the host reads metadata and mounts exactly the one panel that
  is open.
- A render slot is unconditionally reorderable, so it would owe an authored
  `config/primitives/data-view/primitives.data-view.control.jsonc` carrying a
  build-blocking `// @review` marker — for a fixed reading order that `order`
  already expresses. **This slot owes no config override.**

`DataViewSlots.Setting` survives unchanged, one level down: a *control* is a
toolbar affordance, a *setting* is a section inside one control's panel. Flattening
the two would put Properties / Group by / Fields in competition for the toolbar's
single line.

### One merged context

`useDataViewControls()` (`web/components/controls/controls-context.tsx`) is what
both a control's panel and a `Setting` contribution read — there is one context,
not a "controls" one and a "settings" one, because the settings menu *is* a
control. Everything on it is computed once in `DataViewBodyInner` and merely
re-homed; nothing is derived here. In particular `filter` and `sort` are the same
controller objects the row pipeline uses, so a summary and what actually filters
cannot come from two computations.

It is provided around **the toolbar and the surface's `aside`** (two providers
of one value — see "Floating chrome"), never around the view body: view
children have a deliberate contract (`DataViewRenderProps`), and an ambient back
door to `viewModel` would be a second undocumented seam. Popovers portal out of
the DOM but stay React children, so the context still reaches every panel.

### The trigger is icon-only, everywhere

`ControlTrigger` draws a ghost `IconButton`, `secondary` while the control is
narrowing what you see. No summary text on the button, no `+N` badge, and **no
width-dependent form** — a trigger that spelled itself out when wide and shrank to
a glyph when narrow is the per-surface inconsistency this registry exists to
remove. (Summary pills were tried and reverted: two of them ate the whole toolbar
of the agent-manager sidebar, the app's narrowest DataView.)

### The summary is pure, one function — and TEXT, never chrome

A control's closed state still says what it is doing via `summary(ctx)` → one
`DataViewControlSummary` (`label`, optional `spoken` for a glyph-leaning label,
`more`, `count`) or `null`, spent where it costs the toolbar no pixels:

- the trigger's **tooltip** — `Filter: Status is none of 2 +1` (the glyph form);
- the trigger's **accessible name** — `spoken ?? label`, "+N more" spelled out
  (a bare number beside a phrase is ambiguous with no visual context);
- the **compact fold's** control rows, as trailing text — a row each to spend;
- `count` → the fold's aggregate badge on `MdTune`.

**It cannot be a hook.** The trigger has to render without mounting the panel;
computing N summaries by mounting N panels would make every DataView subscribe to
every control's data on first paint. So `summarize-filter.ts` / `summarize-sort.ts`
are plain functions over state, unit-tested next to their source.

**It is one function returning an object, not `summary` + `count`.** Two
independent functions over the same state can disagree — precisely the bug
`rule-resolution.ts` exists to close (the summary reading "0 rules" while a
value-less `bool` rule silently filtered). The summarizers import `isRuleActive`
(resolves AND `lower(...) !== undefined`) rather than re-deriving it, so the
summary, the count and the evaluator read the operator's one answer.

Value formatting tries the operator's own optional
`FilterOperator.summarize(operand, field)` first — the operand's shape is the
operator's, so only `date · is between` knows it holds a pair of instants — then
falls back generically, omitting an operand it has no readable form for.

Settings deliberately carries **no** summary: view settings are configuration, not
a narrowing of what you see. A summary answers "what am I not seeing, and why";
"Group by: Status" answers neither, and it would still count itself into the
compact fold's badge as though something were hidden. Sort sits between the two:
it earns a summary, because its top level is worth reading from a closed
trigger.

### Panel bodies

A control's `component` is **prop-less** and reads the context, which is what lets
the wide bar and the compact fold mount it through the same
`DataViewControlPanel({ control })` host with nothing left to diverge on. Panels
are drawn with the `control-panel` vocabulary
(`@plugins/primitives/plugins/css/plugins/control-panel/web`) — the panel body
never paints its own surface or picks its own width; `size` is a role
(`menu` | `builder`) and there is no third option.

One capability was traded away: a `Control`'s `isApplicable` is pure and cannot
read another slot, so the settings control can no longer self-hide when no
`Setting` applies. It is always applicable and renders `ControlPanel.Empty` in
that case. In practice nothing changes — custom-columns' "Fields" setting declares
no `isApplicable`, so the gear was already always visible.

**A `Setting` contribution renders its own `ControlPanel.Section`** — a contract,
not a convention. The panel body lays its *bands* out itself, so a contribution
that returned loose rows has no band and no rule, and one that wrapped itself in a
`div` makes that opaque box the band instead of the sections inside it. (The host
therefore maps contributions in through a `Fragment`, never a wrapper — see
`control-panel`'s CLAUDE.md for why `display: contents` matters here.) For the same reason a setting owns
a section and never the panel's `Footer`: Properties' "Show all fields" is its
section's last ROW, because a footer placed from inside one section would sit above
whatever contribution came next.

**A sub-panel is a push, never a second popover.** `usePanelStack()` reaches the
stack the host mounted — the filter builder's nested groups, "Save as preset",
custom-columns' per-field editor and the compact fold's per-control pages are all
pages of the one panel. Note what that costs: a stack entry's `render` closure is
captured when the row is clicked and the pushed page REPLACES the root's subtree,
so a page must read its own state through hooks (`useDataViewControls()`,
`useFilterEditor()`, its own config hook) rather than taking it as a prop. Handing
data down through the closure looks fine and then silently computes the page's
second edit against the tree as it was before its first.

## An option carries its own presentation

`FieldDef.options` is `FieldOption[]` = `{ value, label, variant?, hint? }`
(core barrel). One idea — **an option describes how it presents** — rather than a
value→label map plus a parallel value→variant map that every render site has to
join by hand (six such pairs were hand-written across Events, trace and timeline
before this existed).

- `variant` is a `BadgeVariant` (`primitives/css/badge/core`), applied by the
  read chip; absent ⇒ `"muted"`.
- `hint` is the chip's tooltip — why this value means what it means ("Empty" =
  the run succeeded and found nothing).

`BadgeVariant` lives in **`badge/core`** for exactly this reason: a data
declaration in another plugin's `core` has to be able to spell it, and
`core → web` is not a legal edge. The `VARIANT_CLASS` map stays in `badge/web`,
which re-exports the type so no existing import site changed. Duplicating the
union into `data-view/core` was the alternative and is rejected — one name per
concept.

**Deliberate no-ops.** The inline editors and the filter operand input draw
`ToggleChip`s (`enum-editor`, `tags-editor`, `chip-select-filter-input`) and stay
untinted: `BadgeVariant` is not `ToggleChip`'s vocabulary. Group-by section
labels and the control summaries are text-only. Server-side filter SQL never
reads `label`/`options`, so a tint never reaches the server. User-authored custom
enum columns get **no colour picker** — muted is the right default for values
with no semantics.

### The Cell registry also says whether a type presents as a chip

`DataViewSlots.Cell` contributions carry `chip?: boolean` alongside `component`
(see `CellContributionMeta` in `web/cell-slot.ts`); `enum` and `tags` declare
`chip: true`. `useIsChipField()` is `useResolveCell`'s sibling — both walk the
same `extends` chain through one shared internal lookup, so "which contribution
owns this field" cannot be answered two ways.

It exists because ` · ` is punctuation between two pieces of **text**, and is not
what separates two chips, which already carry their own boundary. The list's
subtitle run therefore draws ` · ` **only between two adjacent non-chip terms**
and parts a chip from its neighbour by spacing alone — otherwise a row of three
enum fields renders `name · [Web page] · [Daily] · [Failed]`, middots glued to
pills, which is worse than the two-line row a field-driven row replaces. The rule
covers the title→first-subtitle-term seam too, since on one line the title is
simply the run's first term.

The list names **no** field type to do this: it asks the registry, per the
collection-consumer rule. The flag is a claim about the field's **TYPE**, not
about one renderer — a consumer's `FieldDef.cell` override on a chip-typed field
is taken to render a chip too (which is how Events keeps its "source type no
longer installed" fallback). An override that renders plain text for a chip-typed
field loses its middots; cosmetic, and the price of not making every consumer
re-declare what its type already said.

## Structured display data (`data`)

`FieldDef.value` is the **comparable** projection — sort, filter, search and
group-by all read it — so it is scalar. `FieldDef.values` is the multi-value
twin for tags. `FieldDef.data?: (row) => unknown` is the third projection:
**structured and display-only**, e.g. an avatar spec `{ icon, color }`.

- **Read only by the field type's cell.** `useResolveCell` computes
  `data: field.data?.(row)` itself and hands it on as `TableCellProps.data`
  (`unknown` at that boundary, like `raw`), so every read site — `FieldCell` and
  the tree's primary label alike — gets it with no signature change. The type's
  cell asserts the shape it expects.
- **Inert by construction.** Nothing comparable reads it: `makeSortComparator`
  drops a rule whose field has no `value`, `isGroupableField` refuses a
  value-less field whatever `groupable` says, the filter picker lists only types
  with an operator set, and default search indexes `value`/`values` only. Pair
  `data` with `value` when a field must also sort or filter. It **does** appear
  in Properties, where hiding it hides it.
- **Fails loudly when nothing can draw it.** `FieldCell`'s last-resort
  `String(value ?? "")` is refused for a `data` field: with no `cell` override
  and no contributed cell for its type, it throws `MissingDataCellError` naming
  the field id and type. A blank cell would hide the real mistake — the type's
  cell plugin missing from the composition.

## Row activation is PER ROW

`onRowActivate?: (row) => void` says every row activates. `rowActivation?: (row)
=> (() => void) | null` says which ones do — the handler's **presence** is the
fact, so there is no predicate beside it to disagree with. Passing both throws.

The handler is an `Activation` (`link-gesture/core`): a plain `() => void`, or a
**link** `{ open, href }`. A row that opens a pane returns one —
`rowActivation={(r) => openPane.to(detailPane, { id: r.id }, { mode: "push" })}`
— so its middle- and ⌘/Ctrl-click open `href()` in a new browser tab, exactly
like a link; plain click and Enter run `open()`. The
`link-gesture/no-click-navigate` lint rule flags an `onRowActivate` whose only
job is to navigate, and a `rowActivation` resolver handing back `() => openPane(…)`.

The host folds either into ONE `DataViewRenderProps.rowActivation: (row) =>
Activation | undefined`, so a view never sees the two. A view never switches on
the union: it spreads `activationProps(act)` (`link-gesture/web`) onto the
clicked element, runs `runActivation(act)` from keyboard / programmatic paths,
and hands primitives that own their own click (`DataTable.rowHref`,
`TreeList.selectHref`, `TreeRowChrome.selectHref`) `activationHref(act)`.

**A view must pass that result straight through — `undefined` and all, never
wrapped in a closure.** `Row` infers its element from
`onClick` (`row.tsx`), and a closure is never null, so wrapping makes every row a
`<button>` with the `renderRow` children nested inside it: invalid DOM for any
control a row body holds, the outer row eating the press, and a list where
nothing activates announcing every row as a button. Locked by
`list/web/__tests__/row-activation.test.tsx`, which asserts the DOM shape — the
handler fired correctly the whole time this was broken.

`DataCard` follows the same rule (no `role`/`tabIndex`/key handler without
`onActivate`). **The table is table-level**, not per-row: `DataTable.onRowClick`
is a table-wide prop with consumers outside data-view, so a non-activating row
there is a live-looking row that does nothing rather than a plain container.
Lifting that means changing `DataTable`.

### Open is a separate gesture (`onRowOpen`)

`DataViewProps.onRowOpen?: (row) => void` — double-click, or Enter on a focused
row — is threaded to `DataViewRenderProps.onRowOpen` beside activation, never
folded into it: a file browser's click selects and its double-click descends.
The **tree** maps it to `TreeList.onOpen`; the **table** to
`DataTable.onRowOpen` (Enter opens, Space still activates, and the second click
of a double-click does not activate again). list / gallery / icons ignore it.

### The click belongs to the row; the pencil belongs to the field

An editable cell does **not** open its editor when you click its value. The
value is transparent to the click, so a click anywhere on a row — over a column
as much as in the gap between two — does the row's own thing. Editing has its
own target: a small pencil beside each editable field, revealed while the
pointer is over that field (`primitives/hover-reveal`'s class pair, so no
render-per-hover), and reachable by keyboard because it is a real button that
can take focus.

The two used to compete for one gesture, and the row lost: with click-to-edit on
every cell, the row's primary action survived only in the slivers between
columns, and a table of editable fields could not be used to open anything.
Splitting the gesture also gave keyboard users an editor they never had — a
`div` with an `onClick` was not reachable at all.

`EditableCell` owns this for **every** view (table, list, gallery, and the tree's
secondary chips), so the answer is the same wherever a field is rendered. The
pencil is always mounted and only faded, so revealing it reflows nothing.

The **tree's primary label** is the one exception and keeps *select-then-edit*
(first click selects/navigates, a second click on the selected row edits) — it is
the navigation target itself, so it has no room beside it for a second affordance
(`EditableTreeLabel`).

## Row tone: a row can read as inactive

`DataViewProps.rowTone` is `(row) => "default" | "muted"`. `"muted"` dims the
row's own title, so a switched-off / archived / finished row reads inactive
without spending a chip on saying so — the thing three plugins hand-rolled
before it existed (`SourceRow` muting a disabled source, `ConversationItem`
muting `gone`/`done`, `ThreadRow` bolding unread).

**It threads like `searchAccessor`, not like `density`.** `density` is a
declaration *about the surface*, so it takes the chrome path. `rowTone` is a
**data accessor** closed over row identity, the same shape as `searchAccessor` /
`onRowActivate` / `hierarchy`, so it flows straight through with no chrome hop:

```
DataViewProps.rowTone
  → DataViewSourceBundle          (Omit<DataViewProps, …chrome keys> — free)
    → DataViewBodyProps
      → DataViewRenderProps.rowTone   the view child tones its own title
```

Concretely: `body-types.ts`, `data-view.tsx` and `merged-data-view.tsx` need no
change at all, because the bundle is derived from `DataViewProps` and the hosts
spread it. The only code is the type declarations, one destructure-and-forward in
`DataViewBodyInner` beside `searchAccessor`, and the barrel exports.

Views never re-spell what `"muted"` looks like: `rowToneClass(tone)` (web barrel)
is the ONE rendering, returning a class only for the non-default tone so each
view composes it on top of whatever colour its own title already carries.

| View | Where |
|---|---|
| list | the title `<Text>`, in both the one-line and the stacked shape |
| gallery | the card title `<Text>` |
| tree | folded into `labelClass`, ahead of `options.labelClassName` so the consumer's own per-row class still wins |
| table | **deliberate no-op** |

The table is a no-op the way the gallery is a no-op for `density` — stated, not
forgotten. Its only per-row seam is `DataTableProps.useRowDecoration`, a single
slot already held by manual-order drag decoration; merging two decorations onto
one hook is its own change, not a side effect of this one.

The tree's `labelClassName` / `rowAccent` stay as the escape hatch. `rowTone` is
the semantic form to reach for first — a tone is a statement about the row, a
class is a statement about pixels.

## Density: how much room the surface gives the view

`DataViewProps.density` is `"comfortable"` (the default) or `"compact"`. It is a
**declaration by the surface**, and it threads through exactly one path, so both
hosts get it from one place:

```
DataViewProps.density  (and MergedDataViewProps.density)
  → DataViewShellFrame prop
    → DataViewShellChrome.density        (web/internal/body-types.ts)
      → DataViewBody
        ├→ DataViewToolbar               the fold rule, below
        └→ DataViewRenderProps.density   the view child tightens itself
```

`DataViewSourceBundle` **omits** `density` alongside `title`/`actions`: it
describes the surface, not the data, so a source contribution cannot spell a
value the body would then ignore.

The **list** child reads it as its default row size — `size = options.size ??
(density === "compact" ? "sm" : "md")`. The **table** hands it to `DataTable` as
`density`, whose compact rows pad with `py-row-compact` (the `padRowCompactY`
density token, by default a third of `--pad-row-y`) instead of `py-row`. The
gallery ignoring it is a deliberate no-op, not an omission: its shape is governed
by the card grid's cell width, so there is nothing a compact surface would ask it
to drop.

## Table view options

`viewOptions={{ table: { … } }}` is a `TableViewOptions` (the table child's
`core`):

- **`columnHeader?: "row" | "first-group"`** — where the column labels sit.
  `"row"` (default) is the sticky header row, unchanged. `"first-group"` drops
  that row and puts the labels on the **first group header**: that header's
  sticky band becomes a subgrid row in which the group label (standard or quiet,
  still collapsible, with its count) spans the leading tracks up to the first
  labelled column, and each labelled column's header sits in its own track — so
  it aligns with the cells by construction and keeps sort-on-click. Every other
  group header is unchanged, and the group headers pin at the toolbar offset (no
  header row to stack under). Ungrouped, or when the first column is itself
  labelled, it falls back to `"row"`. For a short sectioned list that wants its
  labels shown once, as a caption over the first section.
- **`FieldDef.header?: string | false`** (on the field, read by the table only)
  — the column's header text, default `label`. `false` leaves the header cell
  empty (a glyph or position column) while the field keeps `label` in every
  picker (sort, filter, group-by, Properties); it is still sortable from its
  empty header. Under `"first-group"`, "has a header" is what decides where the
  first group's label stops spanning.
- The surface's `density` and `groupHeaders` (above) are honoured too.

### The fold rule

```ts
const compact = density === "compact" || (width > 0 && width < COMPACT_BREAKPOINT);
```

The two halves are OR-ed, never substituted. The **measurement** half is
involuntary: below `COMPACT_BREAKPOINT` (360px) the wide inline row (search + the
control triggers + the switcher) does not fit, and no declaration makes it fit.
The **density** half is voluntary: a 672px popover has the room and still wants
the light form. So density removes the *need* for room; it never asserts there is
any. A compact surface that also happens to be narrow is still compact, and a
comfortable surface that is genuinely too narrow still folds — the single reason
a surface cannot end up wide *and* folded by accident.

### The compact trigger is hover-revealed

The **toolbar row** carries `hoverRevealGroup` and `CompactControls`' trigger
carries `hoverRevealTarget` (`primitives/hover-reveal/web`) — the **CSS-group**
half of the primitive, never `useHoverReveal()`. The state hook would re-render
the whole DataView, every windowed row included, on each pointer enter/leave of
the surface; the class pair is pure CSS and costs nothing.

The group sits on the **bar**, not the DataView root. The root looks like the
friendlier target (the compact bar is mostly empty) and is wrong: it makes every
pass over the list a reveal, so grazing a row flickers a control in the far top
corner, unrelated to what the user was doing. The trigger answers where it lives.

Two conditions suspend the reveal:

```ts
const alwaysVisible = open || searching;
```

- `searching` — the search field holds a query.
- `open` — its own panel is up. The panel is portaled, so the pointer leaves the
  hover group the instant it moves into it; without this the trigger would fade
  out from under the panel it opened.

**Only the query pins it — filter, sort and group-by do not.** This is the
durable/transient split from "State split" above, applied to visibility. Filter,
sort and group-by are *durable narrowings*: they live on the view instance's
config row, authored and persisted and git-promotable, and they are part of what
that named view **is**. A view called "Failed builds" is not a list hiding things
from you; it is that list, and it has nothing to confess. Pinning its trigger
open forever reports the view's own definition back as though it were an
accident.

The query is the other half: an *ad-hoc gesture*, typed and forgotten, which is
exactly why it lives in per-tab `sessionStorage` rather than the config row. Fold
the bar away and it leaves no other trace on screen, so the narrowed list reads
as the view's whole contents. The trigger is what the user follows back to it.

Two earlier attempts got this wrong and are worth naming, because both look
reasonable. The first pinned on `activeCount > 0`, which counts every control's
summary — and since surfaces author a default sort in config (the Build popover's
Recent view authors `startedAt ↓`), the trigger never hid at all. The second
added a `hidesRows` flag to `DataViewControlSummary` so a control could declare
it was withholding rows; the filter set it, the sort did not. That flag is now
**gone**: once a filter stopped pinning the trigger, nothing set it, and a
contract field with no implementer is speculative generality. The signal is the
query the toolbar already holds, passed to `CompactControls` as `searching`.

The badge is unaffected and still counts filter and sort — "N things configured"
is a different and correct statement, and `activeCount` still picks the filled
`secondary` button form over the ghost one. Only *visibility at rest* asks the
narrower question.

This is **one fold with one behaviour**: it applies wherever the compact form
appears, including today's width-folded narrow surfaces — the conversations
sidebar's options button is hover-revealed too. Two visually different compact
bars whose difference nothing in the UI explains would be the alternative.

**The bar stays in flow.** Compact is a thin strip holding the view tabs (shown
only when there is more than one instance) with the hidden trigger at its end; it
reserves its height even when it looks empty and never paints over row content.

### Single-line list rows are the default

`ListViewOptions.lines` is `1` (default) or `2`. At `1` the title and the subtitle
are **sibling truncating leaves of the row's own line** — `Row` composes `Line`,
so the `region-line` + `SingleLineProvider` contract is already there and each
`<Text>` ellipsizes without asking — with an empty `<Fill>` absorbing the slack
before the rigid trailing cell (`align: "end"` fields + the `×N` aggregate badge).
The subtitle's `·` join simply extends to the seam with the title, which on one
line is the run's first term. At `2` the subtitle stacks under the title in a
`Stack`, which resets the single-line context, so each `<Text>` asks for its own
`truncate` — the shape every list had before, unchanged for the surfaces whose
subtitle is prose rather than chips.

What gives first when the line is tight: both leaves shrink at CSS's default
factor, weighted by content width, so the longer one yields more — and the
subtitle, being the `·`-joined metadata run, normally is the longer one. That is
the intent (the title identifies the row) without a shrink-priority primitive
invented for one call site.

**Blast radius is small**: every high-traffic list surface (the conversations
sidebar, mail threads, the events list, deploy history) overrides the row body
wholesale through `viewOptions.list.renderRow` and is untouched. What changes is
the field-driven default.

## Per-item actions

Per-row actions (delete, expand-all, …) are a **cross-view** concern: contribute
an action once, every view renders it in its natural trailing affordance (tree-row
hover-trailing, table-row hover-trailing column, gallery-card top-right hover).

The mechanism is the **`defineItemActions<TRow>(id)` factory** (web barrel),
mirroring the `detail-sections` / `tabbed-view` factory precedent — **not** a
global slot like `View`. `View` is global because views are a *fixed shared
vocabulary* with one render-props contract; item actions are the factory case
because each consumer's row type is disjoint (`Block`, `TaskListItem`, `Agent`).
A global slot would force `ComponentType<ItemActionProps<unknown>>` and a runtime
`kind` discriminator to keep one app's Delete off another app's rows;
per-consumer slots are isolated by construction and keep full `TRow` typing.

Each consumer calls `defineItemActions<Row>("<stable-id>")` once. The result is
**callable for contributions** (`MyActions({ id, component })`, like any
`defineRenderSlot`) and carries `.Row` — the `ItemActionsDescriptor`. Pass it to
`<DataView itemActions={MyActions} />`; the host threads it (plus a derived
`hasChildren` predicate from `hierarchy.getParentId`) into every view, which
renders it in its own affordance. Each action component receives
`ItemActionProps<Row>` (`{ row, hasChildren }`).

### The zone axis: does this action live at rest?

A contribution declares `zone?: ItemActionZone` — `"revealed"` (default, the
hover cluster) or `"persistent"` (painted at rest where the view has a permanent
per-row region). It is a property of the **action**, declared once, so every view
gives the same answer — as opposed to per-view config, which lets an author
promote Play on the card and forget the table row.

Views never branch on zones themselves: they call the ONE shared rule,
`useItemActionZones(itemActions, { hasPersistentSlot })` (web barrel), once per
render and apply the returned `persistent` / `revealed` render functions per row.
`hasPersistentSlot` is **required**, so a new view type must answer it.

| View | `hasPersistentSlot` | Persistent placement |
|---|---|---|
| gallery | `true` | `DataCard.footer` → `<RowActions pin={null} alwaysVisible>` |
| table | `true` | the reserved trailing `auto` track, before the revealed cluster |
| list | `false` | — demoted to the hover cluster |
| tree | `false` | — demoted to the hover cluster |

`false` demotes, **never drops** — a view with no permanent region is still the
only place that action can appear. List/tree say `false` on purpose: a reserved
trailing region would take width from the title in the app's narrowest surfaces
(the Pages sidebar), and no consumer needs one today. It is a one-flag change
when a surface earns it, so `primitives/css/row` and `primitives/tree` stay
untouched.

**`primitives/action-presentation` is a different axis — do not merge them.** It
answers *what form does this action draw as* (ghost icon button vs labelled menu
row); `zone` answers *is the cluster painted at rest*. They compose.

## Field extensions

**There is no second per-row render slot — a per-row datum is a `FieldDef`.** The
field schema is the generic seam (it also buys sort, filter and a table column),
so a private "extra meta" slot beside it is always a duplicate.

`FieldDef.value` is a *synchronous* `(row) => FieldValue` and cannot call hooks, so
a field whose projection must close over **hook-loaded data** owned by another
plugin (e.g. a play-count living in another plugin's live resource) has to be
produced from inside a mounted component.

**One contribution shape.** A field-extension contribution is a **component** (not
a plain `FieldDef[]`) typed `ComponentType<FieldExtensionProps<TRow>>`, where

```ts
interface FieldExtensionProps<TRow> {
  storageKey: DataViewId;                              // which surface
  rowKey: (row: TRow, index: number) => string;        // how to identify a row
  render: (fields: FieldDef<TRow>[]) => ReactNode;      // hand the host the fields
}
```

The registration carries one more thing — **`section: string | null`**, the band
its fields are listed under (see "Field sections" below).

Every contributor receives the **surface coordinates** (`storageKey`, `rowKey`) so
a cross-cutting contributor can key its per-row data over the surface; one that
doesn't need them just ignores them:

```tsx
function RatingFields({ render }: FieldExtensionProps<Item>) {
  const ratings = useRatingsMap();          // hypothetical: this plugin's own live read
  const fields = useMemo<FieldDef<Item>[]>(() => [
    { id: "rating", label: "Rating", type: "int",
      value: (it) => ratings.get(it.id) ?? null, sortable: true },
  ], [ratings]);
  return <>{render(fields)}</>;  // ignores storageKey/rowKey — it keys off its own resource
}
MyFields({ id: "rating", section: null, component: RatingFields });
```

Under a live `source` a contributor needs no hook at all when its data rides on
the rows: a contributed column (`network/live`'s `liveColumns`) is read off the
row and bound as the field's `column`, so the server sorts and filters by it —
Sonata's play-count field is `{ value: (s) => playbackColumns.read(s).playCount,
column: playbackColumns.column("playCount") }`.

**Exposed fields come before the fold, with no contributor.** An entity
extension that EXPOSES fields (`defineExtensionShape({ exposes })`, registered
by `LiveExposures.Register` — `network/live`, "Exposed fields") is in the
schema of every DataView whose rows reach its entity: `useExposedFields`
(`web/internal/exposed-fields.ts`) derives one `FieldDef` per exposed field
(id the bare field key — saved views keep naming it; `enum` with its options
when it declares them, else its field type; the registration's cell / width /
align), and `CollectBodyFields` appends them to the host's fields before
`CollectFieldExtensions` — an id the host (or another exposure) already uses
throws. The collection is the live source's, or — for in-memory rows taken
from one (the Queue) — the origin's `collection` prop; only a live source
binds `column`, so an exposed groupable column groups as server sections
(`LiveGroupColumn.handle` goes to the groups read). Prefer an exposure over a
per-list field-extension slot for a field of an entity extension.

**A field's own read: `pending` and `readError`, never a stand-in value.** A
contributor whose values come from a read of its own states where that read
is — never folds "not known yet" into a value. `pending: true` while it loads
with nothing held: each cell draws the loading block, and a view that groups,
sorts, filters or folds by the field (`fieldsReadByView` — the fold IN
EFFECT, never the stored one a typed search or a fold-less view suspends) renders its loading
state, because whatever `value` returns meanwhile would lay the rows out by a
claim (an enum's `null` is its "None" bucket — every row filed under it).
`readError` once it failed with nothing held: each cell draws the failure with
Retry, and a view laid out by the field renders that failure in place of its
rows (`field-error`, naming the field). A failure over held values keeps
painting them. The task list's `category` field is the case that needed both.

**Two registration entry points, one mechanism.** A field extension reaches the
host through exactly one of two places — the difference is only the **registration
site** (and, consequently, the row typing):

1. **The always-on global `DataViewSlots.FieldExtension` slot** — the
   **cross-cutting** case: a single slot **every** DataView folds, for a
   contributor that augments *all* surfaces (custom-columns' user-defined columns).
   It is literally `defineFieldExtensions<unknown>("primitives.data-view.field-extension")`
   — the same factory minted once at `<unknown>` (a global slot spans disjoint
   consumer row types, so `rowKey` is `(row: unknown, …) => string`). A cross-plugin
   contributor imports the slot and contributes itself (`custom-columns →
   data-view`, the legal parent-ward edge), so the host names **no** individual
   contributor.
2. **The per-consumer `defineFieldExtensions<TRow>(id)` factory** (web barrel), the
   sibling of `defineItemActions` — the **typed/scoped** case (disjoint row types
   per consumer → a factory, per the same collection-vs-factory rule). Each
   consumer calls it once with a stable id; the result is **callable for
   contributions** (`MyFields({ id, component })`, like any `defineRenderSlot`) and
   — being a slot — is itself the `FieldExtensionsDescriptor` the host reads (no
   extra `.Row`-style member, unlike item-actions). Pass it to
   `<DataView fieldExtensions={MyFields} />` (Sonata's play-count / last-played
   fields). Full `TRow` typing.

**One fold over an ordered source list.** `CollectFieldExtensions` (internal) folds
`[DataViewSlots.FieldExtension, ...(props.fieldExtensions ? [props.fieldExtensions] : [])]`,
threading `{ storageKey, rowKey }` to every contributor — each mounts
error-boundary-isolated (`renderIsolated`), runs its own hooks, yields its
`FieldDef[]`, and recurses; the base case calls `children([...base, ...allExtra])`.
Both the source-level and contribution-level folds are recursive **components**,
never a `.map` over contributed hooks (which `react-hooks/rules-of-hooks` rejects).
The fold wraps the model **before** the sort/filter controllers, so a contributed
`int`/`date` field shows up in the Sort control, the Filter control, and the table
columns for free. It runs at `<unknown>` (the global slot spans disjoint consumer
row types), so `props.fields`/`rowKey` and the merged result cross a safe
`FieldDef<unknown>`↔`FieldDef<TRow>` cast at the top-level `DataView` boundary; the
global slot being a `defineRenderSlot`, its fold order is a committed reorder
override (`config/primitives/data-view/primitives.data-view.field-extension.jsonc`).

**Intentional asymmetry vs `RowOrder`.** There is deliberately no
`GlobalFieldExtensionProps` (a field extension is one shape whether registered
globally or per-consumer) while the sibling `GlobalRowOrderProps` remains:
`FieldExtension` had **two** cases to unify (global custom-columns + per-consumer
Sonata); `RowOrder` has only the global one (`view-order`), so there is nothing to
symmetrize. Do **not** "restore symmetry" by re-splitting `FieldExtension` or by
minting a per-consumer `RowOrder` factory that has no consumer. See
["The global `RowOrder` slot"](#the-global-roworder-slot-cross-plugin) under
Manual order.

### Field sections: a band per contributor

A schema several plugins contributed to is a flat list of forty columns unless
something says where each came from. `FieldDef.section` is that: the heading a
field is listed under in **every** "choose a field" surface — the filter and sort
typeahead, the Properties list, the group-by band. The host's own fields sit
first under `SHARED_FIELD_SECTION` ("Common"); each contributor's follow under
its own name, so the merged run surface reads `Common / Build / Backup / Release
/ Deploy` everywhere instead of one undifferentiated list.

**A contributor never authors it per field.** `FieldExtensionContribution.section`
is declared once on the registration and the fold **stamps** it over every field
that contributor returned (`sectioned()` in `field-extensions.tsx`), so a plugin
cannot spell its own band two ways across forty columns, forget it on the
fortieth, or file a column under another plugin's name. Authoring
`FieldDef.section` by hand is for a HOST splitting its own base schema into
bands.

It is **required and nullable**, not optional: `null` says "these are ordinary
fields of the host's own schema" (one `Starred` boolean on the pages sidebar,
`Category` on tasks) and is a real answer, distinct from an arm that merely
forgot — which, defaulted, would file its columns under the host's own name with
nothing to catch it.

Three rules fall out of it, all in one place each:

- **Headings appear only when there is something to tell apart.** `FieldSections`
  (`web/internal/field-sections.tsx`) is the one component every surface draws its
  field list through; with a single section it draws no heading at all, so a
  plain one-plugin schema keeps the flat list it always had. The heading is
  `ControlPanel.Subhead` — the panel vocabulary's own member, so it follows the
  panel's label rails and typography instead of being hand-rolled here; carrying
  no rail class of its own is what also makes it right in the one surface with no
  panel around it (`field-picker.tsx`'s bare `InlinePopover`), where it lands on
  that region's own content edge.
- **The typeahead matches the band's name too** (`fieldSearchText`), so typing
  "deploy" in the filter picker offers the deploy arm's eight columns whatever
  they are individually called.
- **The band order IS the body order.** `orderFieldsBySection` (core) is applied
  by both `resolveBodyFields` and the Properties controller's item list, and
  Properties draws one `SortableList` per band — so a drag reorders within its
  own source, and a column can never sit between two bands in the table while
  the list that ordered it shows it inside one. The cost is deliberate: columns
  from two sources cannot be interleaved.

## Collection-consumer separation

Consumers import **only** `DataView` + the core types from this umbrella and select
views by **type** id (`views={["gallery", "table"]}` — `DataViewContribution.type`
ids, not instance ids). They **never** import a view child. Adding a view type is a
new child plugin with zero consumer changes.

## Adding a new view child

1. Create `plugins/primitives/plugins/data-view/plugins/<view>/`.
2. In its `web/index.ts`, contribute one entry to the slot:
   `DataViewSlots.View({ type: "<view>", title, icon, order?, hierarchical?, component })`.
   The `type` is the view-type's registry id (what consumers list in
   `views={[…]}`).
   The `component` is a `ComponentType<DataViewRenderProps<unknown>>` — it receives the
   **raw** `rows`, the `fields`, `rowKey`, the view's `ViewState`, `setSort` /
   `setFilter` bound to this view, `onRowActivate`, `searchAccessor`, `hierarchy`
   (present only for hierarchical sources), the opaque `options`
   (= `viewOptions[viewId]`, cast internally to the view's own typed options), and
   `emptyState`. The view applies its own row processing (flat views call
   `useFlatRows`). Re-cast `rows`/`fields`/`options`/`hierarchy` from `unknown` to
   `TRow` at the component boundary (the documented cast site).
3. Run `./singularity build` — the plugin registry (`web.generated.ts`) is autogenerated
   from the filesystem, so the new `web/index.ts` is discovered automatically (no manual
   registration). Done — every existing `<DataView>` consumer can now opt in by id.

## Filtering

Per-field filtering is driven by `FieldDef.type`: the Filter control's panel
writes a `FilterGroup` tree to `state.filter`, and every view evaluates it through
the ONE filter language (`network/live/plugins/filter`, design in
`research/2026-09-25-global-unified-filter-language.md`):

- **Operators lower, they do not predicate.** Each field type's
  `FilterOperatorSet` (resolved via `useResolveOperatorSet`, honouring `extends`)
  declares its language `domain` (`text` / `number` / `boolean` / `instant` /
  `stringArray`), and each `FilterOperator.lower(operand, { column, now })`
  returns the rule as a language `Filter` over `column` (the field id) — or
  `undefined` for an INCOMPLETE rule (empty operand, open range). That one answer
  is both the evaluator's no-op gate and the chip counter's `isRuleActive`, so the
  two cannot disagree. Negative operators lower to the language's complement ops
  (`ne`, `notIn`, `neCi`, `notContains`, `hasNone`, `isNotEmpty`), so they KEEP a
  row with no value.
- **`lowerFilterGroup(group, fields, resolveOperatorSet, now)`** walks the tree:
  a dangling or incomplete rule is TRUE (dropped from an `and`; it makes an `or`
  TRUE), an empty group is TRUE, a one-child group is its child. It returns
  `{ filter, readsClock }`; `readsClock` is recorded generically (`ctx.now` is a
  getter), so a relative date anchor ("Today", "within the past week") marks the
  filter clock-dependent without data-view naming the date type. Relative time is
  lowered HERE, on the client, to absolute ISO instants — the language has no
  clock.
- **In memory** (`applyFilter`, `useRowFilter`): lower once, then
  `matchesFilter` per row over a record of just the columns the filter reads. The
  row value is `projectFieldValue` coerced to the set's domain by ONE adapter,
  `coerceToDomain` (text: arrays join with " ", `Date` → ISO, else `String`;
  number: finite or NULL; boolean: truthiness; instant: `Date` / epoch ms /
  parseable string → `Date`, else NULL; stringArray: the array or NULL) — the
  language itself stays strict.
- **Day rollover**: `useRowFilter` lowers against `useFilterClock(readsClock)` —
  local midnight, re-armed with one timer at the next local midnight ONLY while
  the filter reads the clock (the same day clock as `useGroupingClock`).

Flat views apply it inside `useFlatRows` (search → filter → sort); the tree view
applies it subtree-preserving before handing rows to the tree primitive; the fold
rule's `keep` tree goes through the same `useRowFilter`. Filter semantics are
therefore identical across all views.

### A source's filter: nothing falls back to the client

A live `source` (below) runs filter / sort / search / paging on the server, so
the host must never offer a filter the server cannot run, nor drop one on the
way. `web/internal/live-filter.ts` holds the lowering every such source shares:

- **A SAVED rule the source cannot run** — its field's column not filterable or
  gone, its operator gone — is refused (`UnavailableFilterRuleError`; a sort
  rule likewise, `UnavailableSortRuleError`) and the surface says which rule,
  instead of silently running the rest of the filter and showing rows the view
  claims to hide. (An incomplete rule is not an error: it constrains nothing,
  as authored.)
- **`useViewFilter`** lowers the view's `FilterGroup` over field ids against
  `useFilterClock` (armed only while a rule reads the clock, so "Today"
  re-queries at local midnight); **`lowerSearch`** lowers the search box to
  `or(contains(col, q) …)` over the source's `searchable` text columns.
- **A tree over the language's bounds** (depth 4, 50 clauses, 100 list values)
  is refused: `canonicalizeFilter` throws `FilterError`, the query is not read,
  and the surface renders the error in place of the view — never a
  silently-trimmed filter.

Operator-set tests pin a lowering by its effect on values with
`lowersToMatch(op, domain, operand, value, now?)` from
`@plugins/primitives/plugins/data-view/web/testing` — the evaluator's exact path
for one rule.

**Filter presets** are the twin of the sort presets: a named, reusable
`FilterGroup` saved in the sibling `filterPresets` key of the same per-surface
config doc (via the `presetsExtraFields` seam injected into the views descriptor —
view-core never names it). The filter panel hosts the saved presets in its top
section (apply = write the preset's group verbatim into the live filter) plus a
`Save as preset` footer row, exactly like sort. Both are drawn by the shared
`web/components/presets/` pieces. Deleting is the row's own hover-revealed trash
(`ControlPanel.Row`'s `actions` slot, which makes the click target a sibling of
the button rather than its ancestor); because a lost filter tree cannot be
reconstructed, the delete raises a toast whose Undo restores the preset at its
original index. Hook:
`useFilterPresets(storageKey)`; readers `readFilterPresets` /
`filterPresetMatchesGroup` live next to the sort readers. A preset's group is
stored opaquely as a `jsonField<FilterGroup>` (validated whole through
`FilterGroupSchema` on read), git-promotable like every config row.

### Live sources (`source`): a `network/live` collection as live key-range pages

A DataView's rows come from exactly ONE origin — `DataViewProps` is a union, so a
stand-in (`rows={[]}` beside a server origin) cannot be spelled:

- `{ rows; loading?; rowKey }` — in memory;
- `{ source }` — a live collection (`liveDataSource`, web; its types are
  core's), read as
  `network/live`'s key-range pages (`useLive`), kept live by the rows on
  screen (*Paging* above). It refuses `rowKey` (the
  row key is the collection's `id`, the one the runtime keys its deltas by),
  `hierarchy` (a tree over a paged set orphans children), `manualOrder` (a rank
  would reorder server-sorted pages) and `searchAccessor` (search is the
  source's `searchable`); the contributed `RowOrder` stays off too.
  `DataViewSourceBundle` is a DISTRIBUTIVE `Omit`, so the `MergedDataView` path
  keeps the union (pinned by `web/internal/body-types.test.ts`).

```ts
// web — once, next to the list (any collection with a window)
export const threadsSource = liveDataSource(mailThreads, { searchable: ["subject", "snippet"] });
// web
<DataView<MailThread> storageKey={…} fields={fields} views={["list"]}
                      source={threadsSource.scoped({ where: { accountId } })} … />
{ id: "labels", column: mailThreads.column("labelIds"), values: (t) => t.labelIds, … }
```

- **`scoped({ where })`** ANDs a base filter into every tuple, before the view's
  own; its columns must be filterable (the codec checks). While the scope's
  VALUE is still loading (mail's account, a composition's name), mount the
  DataView anyway over `source.awaitingScope([columns])`: it reads nothing and
  shows the list's own loading state with its toolbar already up — one loading
  state, not a bare skeleton the toolbar then pushes down. The Filter control
  never offers a field over a column the scope constrains (`resolveLiveFields`
  leaves it out of `filterFields` — it still sorts), so the user can neither
  name nor widen the scope: a rule over it could only restate it or contradict
  it into an empty list.
- **Facets** (`liveDataSource(c, { searchable, facets: ["kind", "source"] })`):
  declared `text` columns whose option list is READ, not declared. For each,
  `CollectFacetOptions` (`web/internal/facet-options.tsx`, inside
  `CollectBodyFields`) reads `useLive(c, { groupBy, where: scope, limit:
  groups maxLimit })` and hands the field over that column
  `optionsResult: FieldOptionsResult` — `ResourceReadiness`'s loading / error
  arms, or `{ status: "ready", options }`. `FieldDef` takes `options` XOR
  `optionsResult` (a type union). The filter input renders loading, or the
  failure with Retry — never an empty grid. Options are value-sorted (never the
  grouping's count order) and keep their identity across a count change; a
  grouping full at its max is refused (`refuseResource`) as the error arm —
  never a silently truncated option set. A field over a facet that declares
  `options`, or a facet no field reads, throws at mount; an awaited scope reads
  nothing (the facets stay loading). The reads are sibling components reporting
  up, so a scope arriving under a mounted body does not remount it.
- **`FieldDef.column`** maps a field onto a collection column when its id is not
  that column's name — minted only by `collection.column(name)` or a
  contributed-column handle's `.column(field)`, carrying its collection's key.
  Field ids stay the persisted vocabulary. A field without one lowers under its
  own id; a field bound to no column (a derived value) is display-only. A SCOPED
  column's ref (`scopedLiveColumns(...).column(member)` — a surface's custom
  column) names a scope instead of a collection, and resolves only on a source
  whose collection's `columnScope` is that scope.
- **A collection with a `columnScope` is listed on that one surface**: the host
  asserts at mount that it IS the DataView's `storageKey`
  (`liveColumnScopeOf`), and hands it to every field extension as
  `FieldExtensionProps.liveColumnScope` (`null` on any other origin) — the
  custom-columns contributor binds its fields under it, so a custom column sorts
  and filters on the server like any column.
- **Checked where declared** (`web/internal/live-fields.ts`): a field bound to a
  column must resolve — marked `sortable: true` over a column that does not sort
  throws, a filterable one whose operator set lowers over another domain than its
  column throws, a ref naming another collection throws. The host's own fields
  are checked in `DataViewBody`; a `FieldExtension` contributor's inside its own
  `render(fields)`, so its item boundary contains the crash and the error names
  it. A `column` on an in-memory DataView throws (it would be ignored).
- **Lowering** (`web/internal/live-source.ts`, `useLiveSource`): the Filter
  control offers only fields whose column is filterable, the Sort control only
  those whose column sorts. The view's `FilterGroup` lowers over field ids
  (`useViewFilter`, relative dates on the day clock), then each clause's field
  id is renamed to its column, ANDed after the source's scope with the search box
  (debounced 200 ms, `or(contains …)` over `searchable`), and canonicalized; a
  tree over the language's bounds is the error arm. Sort rules map to columns (an
  empty sort takes the collection default); a duplicate column is dropped. A
  query naming a contributed column hands the codec that handle.
- **A saved rule that does not resolve** is PENDING while the deferred plugin
  tier is still loading (a contributor may not have registered its field yet —
  the skeleton), and the error arm once it settled
  (`UnavailableSortRuleError` / `UnavailableFilterRuleError`).
- **Group-by** lowers per `liveGroupLowering` (`web/internal/live-fields.ts`)
  — the ONE answer the Group-by control (what it offers, through
  `DataViewControlsContextValue.offersGrouping` / `groupableField`) and the
  source (what it reads) both take:
  - **Server sections** — a `oneBucketPerValue` grouping (identity, enum, bool;
    never a date bucket) over a **groupable** column: the collection's OWN
    filterable text / number / boolean column, or an EXPOSED one
    (`LiveFieldPlan.groupColumns`; what live's `checkGroupBy` accepts — a
    contributed column never is). The
    origin is `SourceView` `kind: "sectioned"` (`useLiveSource` →
    `useSectionedReads`): ONE `useLive(c, { groupBy, where, limit: LIST_MAX })`
    over the SAME lowered `scope ∧ filter ∧ search` the rows use lists every
    section with its exact, live count (`serverSections`,
    `web/internal/live-sections.tsx`: each group's bucket from the type's own
    `grouping.plan`, ordered by bucket ordinal × `groupOrder` — never the
    server's count order — with NULL, and for text a blank value, merged into
    the one "None", last). Each section reads its own rows — a `SectionRead`
    paged read over `where ∧ eq(col, value)` (`isEmpty` for None), in the view's
    sort with no group prefix — only while it is **active**: its footer asked
    for its first page (it is expanded and came into view) and it is not
    collapsed; the latch resets when the query (minus search) does. Thirty
    groups below the fold read nothing. The reads are sibling components the
    body mounts (`readers`, the `FacetRead` pattern), so a section opening or
    closing never remounts the body. A search-only change keeps the last
    ready groups until the new read settles. Full at `LIST_MAX` groups, the
    body footer says so ("the smallest groups are not listed"); a filter or
    search naming a contributed column is the error arm
    (`UngroupableFilterError` — a `GROUP BY` cannot count it).
  - **Order prefix** — a `oneBucketPerValue` grouping over a column that only
    SORTS: it is prepended to the order and its sections follow first
    appearance (`sectioning: { kind: "appearance" }`).
  - **Buckets** — any other grouping over a sortable column: partitioned from
    the loaded rows, in bucket order.
  - Over neither (a derived value) the grouping is **not offered**: its
    sections could only say what happens to be loaded.

  This rests on the contract every live lowering does (`FieldDef.column`): a
  field's `value` IS its column's value — a field showing a derived value is
  offered for none of sort, filter and group-by.
- **Declared sections reach the views as data.** `DataViewRenderProps.sectioning`
  is `{ kind: "bucket" | "appearance" }` (partition the rows) or
  `{ kind: "declared", sections }` (`DataViewDeclaredSection`: key, label,
  exact count, the section read's rows, its `paging`); a view hands it to
  `useDataViewSections` untouched. `partitionIntoSections` then emits every
  declared section — an empty one too — with the server's count, and
  `DataViewSection.paging` (`DataViewSectionPaging`) carries the section's own
  paging. `SectionBody` ends in it (`SectionPagingFooter`: the same
  `useInfiniteScroll` + `InfiniteScrollFooter` the body footer is made of),
  so rendering a section body IS rendering its footer — list, gallery and
  icons through `GroupedSections`, the table in `DataTableGroup.footer`. The
  fold holds a section's paging while its loaded tail is folded (rule 6, per
  section); an aggregate over a section still paging is a lower bound. The
  body-level tail hold does not apply (there is no single tail); the body
  footer shows only the groups read.
- **Section counts are a type** (`SectionCount`: `exact` | `atLeast`), printed by
  one formatter (`formatSectionCount`: `n` / `n+`) and derived from loaded rows
  only: exact when every row is loaded (`DataViewRenderProps.rowsComplete` —
  always in memory; a live origin once read to its end), or — sections in row order — when a later section has started.
  A declared section's count is the server's, exact.
- **States.** The skeleton while the head page (or a pending rule) is pending;
  the empty state once the head settled with no row; an unavailable rule
  (or a filter over the bounds) in place of the view, as its message; a head
  read that failed with nothing to show as `SourceView.readError` — the same
  `error` arm a `readiness` read fails with (`resolveBodyState` → `errorState`,
  else `ResourceErrorInline`: Retry, or Reload for an out-of-date tab), so a
  live list fails exactly as a resource-backed one does; a failure paging stopped on
  (`LivePageError.blocksPaging` — the last page's, or one holding the read short
  of its end) in the footer (its own Retry — `useInfiniteScroll`'s `retry`,
  never the next page); any other page's error as one notice above the rows
  ("Rows after ‹row› could not refresh — Retry"), keyed by the failing read. A
  search-only change keeps the previous rows until the new head settles; any
  other query change starts over. A read that cannot page past its last page
  says so in the footer (`InfiniteScrollFooter`'s `truncated`), in the user's
  words per `PagesTruncation` kind (`TRUNCATION_HINT`: an over-long sort key);
  the plan's own wording goes to the `live-pages` log. A page scrolled far away
  keeps its rows, stale, until it is in view again.
- **Column headers sort only what the source sorts.** `DataViewRenderProps.sortHeader`
  carries the Sort control's sortable field ids and the ACTIVE sort (for the
  arrow — `state.sort` is emptied under a server-ordered origin); the table
  offers header sort on those fields only, and the host's `setSort` throws for
  any other, so a click can never persist a rule the source refuses.

### Typed fields are the generic extension point

To make a data-view filterable on a new dimension, **add a typed `FieldDef`** —
do **not** bolt a bespoke toggle chip onto the toolbar. A field whose `type`
resolves a `FilterOperatorSet` (`bool`, `enum`, `number`, `date`, `tags`, `text` —
all already registered; each declares its filter-language `domain`) automatically appears in the "Filter" pill; `enum` fields
read their choices from `FieldDef.options`. This is also the generic substrate for
future configurability (saved filters, sort, grouping): they operate on the same
field schema, so a new typed field unlocks all of them at once with zero chrome code.

The **tree** view honors both **filter** (subtree-preserving) and **sort**. It
**defaults to manual (rank) order** — an empty `ViewState.sort` keeps rows in
rank order (the DnD-reorderable order) — and when a field sort is picked it
reorders each **sibling group** by that field (a stable global sort of the flat
row list, which `buildTree` re-groups per parent), suspending DnD reorder while
active. The `supportsSort: false` `DataViewContribution` flag (a data-view flag,
*not* a generic `ViewTypeMeta` key — view-core never knows about sort) exists for a
view type with no meaningful field-sort axis: the Sort control's `isApplicable`
then drops it while the Filter control stays. Flag omitted = honors sort.

Body rendering is **show-all by default**, governed per view-instance by
`visibleFields` (below) and *not* tied to `primary` — so a field is visible in the
body **and** usable in the filter builder unless a surface explicitly hides it. To
keep a field **filter-only**, author a narrow `visibleFields` on that view that
omits it (and set
`filterable: false` to also keep it out of the full-text search accessor) — as the
settings config nav does (`visibleFields: ["label"]` in
`config/config_v2/settings/config_v2.settings.nav.jsonc`, keeping its `modified` /
`conflict` / `source` fields as pure filter dimensions), and as the studio explorer
does with `visibleFields: ["name"]`.

## Per-view visible fields (Properties)

Which fields a view renders in its **body**, and in what order, is a per-view-instance
dimension — the visible-fields twin of `sort` / `filter`, stored in the **same `view`
blob** as `visibleFields?: string[] | null`:

- **`null` / absent (the default)** → the **schema's own default body set**: every
  field in schema order except those declaring `FieldDef.visible: false` (below).
  Newly added fields (including a freshly added custom column) auto-appear with zero
  user action.
- **explicit `string[]`** → exactly those field ids, in that order; everything else is
  hidden. Order is meaningful — it is the body order (table columns, gallery/list
  property rows, tree secondary chips). Like Notion, once a view is customized,
  later-added fields stay hidden until toggled on.

### `FieldDef.visible` — a field can be a dimension without being printed

`visible?: boolean` (default `true`) is the **schema's** half of the same
question: `false` means the field feeds sort / filter / group-by / search only
and is not in the default body set — the user can still switch it on from
Properties. It is what a surface reaches for instead of authoring a narrow
`visibleFields` array purely to omit one field.

**Two places hardcoded "show everything", and both read it** — this is the part
that is easy to half-do:

- `web/internal/resolve-body-fields.ts` — the unconfigured branch now filters
  `f.visible !== false`. Without this the flag does nothing at all.
- `web/internal/use-visible-fields-controller.ts` — the unconfigured branch seeds
  each item's checkbox from `field.visible !== false` rather than a literal
  `true`. Without *this* the field renders **checked** in the Properties list
  while the body leaves it out, and the first click on that checkbox visibly does
  nothing.

Sort / filter / search are unaffected by construction, not by care: every view
runs `useDataViewSections` over the full `props.fields` and calls
`resolveBodyFields` afterwards, on a separate value.

**The one semantic to accept.** In a view whose config already holds an explicit
`visibleFields` array, a `visible: false` field is indistinguishable from "a field
the user never switched on" — the array simply does not mention it. That is the
existing, intended Notion-parity behaviour, and it means `visible` is a
**default, not an enforcement**. For the same reason "Show all fields" resets to
`null`, i.e. back to the schema default — a `visible: false` field returns to
unchecked rather than appearing.

Custom columns need nothing: they are folded into `props.fields` before any view
calls `resolveBodyFields`, and an absent `visible` reads as `true`.

`visibleFields` governs **body rendering only**. Filter, sort, and search always
operate on the **full** `FieldDef[]` schema — a hidden field stays filterable and
sortable. The shared `resolveBodyFields(fields, visibleFields)` helper maps the blob
to the ordered visible subset each view renders; the primary/title slot in
gallery/list/tree is then `pickPrimaryField` over that **visible** subset (so a hidden
title falls back to the next visible text field).

Users edit this from the **View settings** control (`MdTune`) — the
**"Properties"** entry in its "Current view" section, a `view`-scope `DataViewSlots.Setting` contribution
(`PropertiesControl`) sitting alongside "Group by": a sortable, checkbox list to
reorder / hide fields, plus a "Show all fields" reset (back to `null`). The setting
gates itself to surfaces with more than one field (via the contribution's
`isApplicable`, which the menu reads generically — it never names Properties). Writes
go to the view's config row exactly like sort/filter (`updateView(id, { visibleFields }, { merge: true })`),
so the choice is durable and git-promotable. Surfaces wanting a deliberately narrow
body author `visibleFields` directly in their committed `.jsonc` — see the
config-nav example under "Filtering".

## The rail (the inverted topology)

Every horizontal band the DataView owns — toolbar, view bodies, group headers,
table rows, loading skeletons — applies `rail-follow`
(`padding-inline: var(--rail-start, var(--chrome-pad-x))`). Vertical rhythm stays
on the named spacing ramp.

**The DataView container itself never pads — its bands do.** That is the inverse
of the rail contract's normal shape (container pads, children inherit) and it is
deliberate: flipping it means `PaneChrome` becoming a region owner, which would
inset every pane in the app including the deliberately full-bleed ones. The two
consequences you must hold in mind:

- A host that insets a DataView itself **opens a region** — `rail-<step>`, which
  pads and publishes in one declaration, and so sets `--rail-owed-*` to zero: the
  owner paid, followers owe nothing. (`detail-sections`' `Host`, `SectionCard`'s
  body, task-detail's tasks pane.) Never `Inset` + a rail class on one box:
  `Inset` pads without publishing, so the pair would announce a rail that
  disagrees with the padding actually applied.
- A host wanting a **different** rail publishes `--rail-start`/`--rail-end`
  *without* padding — the app-shell sidebar does, at `--space-sm`, which is why a
  sidebar DataView's chrome lands on the sidebar's pill rail. Here the follower
  still owes the rail, and pays it.

See `research/2026-08-17-global-inset-ownership-rail-contract-v2.md`.

## Placement: always natural-height, never owns a scroll

`<DataView>` has **no placement mode** — it is **always natural-height** and
**never owns a scroller**. The root is a plain block box (`<Stack gap="none">` =
`flex flex-col`, *no* `min-h-0 flex-1`), so the body grows to its natural content
height and the **enclosing pane owns exactly one scroll**, provided by
`<PaneScroll>` (`@plugins/primitives/plugins/pane/web`). The single-scroll model
removes the whole class of nested/severed-scroll bugs.

- **The toolbar is a `<Sticky edge="top" mask>` header.** The `<Stack gap="none">`
  root is each DataView's own sticky **containing block**, so stacked DataViews
  hand off automatically — when a section scrolls out its toolbar un-pins with it,
  no `active` toggling or computed `top` offsets. The `mask` prop paints
  `bg-chrome-mask` so rows never show through the pinned bar, following the surface
  the DataView is embedded in (page canvas, sidebar, `<Surface>`).
- **The pane provides the scroll.** `PaneChrome` routes its body through
  `<PaneScroll>`, so a DataView rendered as `PaneChrome` children scrolls for free;
  a non-pane host must supply its own `<PaneScroll>` (or equivalent `overflow-y`
  scroller) around the DataView.

**Dev-mode structural guards.** On mount `<DataView>` runs two loud-but-non-fatal
checks (`console.error`, never throw — safe for overlay/SSR edges), after one
layout frame (`use-dev-guards.ts`):

1. **Single-scroll.** Walks up for the nearest ancestor the content vertically
   overflows; if that ancestor clips (`overflow-y ∉ {auto, scroll, overlay}`) the
   pane forgot its `<PaneScroll>` and the view is unscrollable.
2. **Chrome-mask match.** The sticky toolbar masks with `--chrome-mask`, which
   must equal the actual painted background behind the DataView. Every `<Surface>`
   (and the page canvas / sidebar / theme scope) co-publishes `--chrome-mask`
   alongside its background, so this holds by construction for surfaces built
   through the primitive. The guard compares the root's computed `--chrome-mask`
   against the nearest actually-painted ancestor background — catching an **ad-hoc**
   `bg-muted`/`bg-card` wrapper that paints a surface without co-publishing (a lint
   can't see it: the surface is a runtime ancestor). Fix: route the wrapper through
   `<Surface>`.

The band (toolbar, filter bar, view switcher) renders unless the surface passes a
hosted toolbar — see "Hosted toolbar: no band"; its controls then live behind
the frame's options trigger, never nowhere.

## Row virtualization (`VirtualRows`)

Large views window their rows through the shared `<VirtualRows>` component, which
lives in its **own leaf primitive** (`primitives/virtual-rows`) — not the data-view
barrel — so both `data-view/list` and the `primitives/tree` primitive (which
`data-view/tree` builds on) can consume it without a layering inversion. It wraps
`@tanstack/react-virtual` with dynamic row measurement (variable heights) behind a
small API: `items`, `estimateSize`, `getKey`, `itemClassName?`, `overscan?`,
`scrollToIndex?` (`align: "auto"`, for host-driven selection reveal), plus a
`children(item, index)` row renderer.

**It self-discovers the scroll container** — `findScrollParent` walks up to the
nearest ancestor whose `overflow-y` is `auto`/`scroll`/`overlay` (fallback: the
document scroller), then measures `scrollMargin` (the list's offset within that
scroller) so windowing is correct even when a sticky toolbar / tab strip sits above
the list. Deliberately *not* a threaded-in ref: since the DataView never owns its
own scroll, windowing binds to the pane's single `<PaneScroll>` (or any outer
scroller the host provides), and the sticky toolbar's height folds into the
measured `scrollMargin` automatically.

Every view windows today, each at the threshold its own row shape justifies, and
always **within** a group section (grouping is the outer structure, windowing the
inner one — so a section's header is always mounted and `StickyStack` can measure
it):

| View | Threshold | Notes |
|---|---|---|
| **list** | 100 entries | Composes with manual-order drag via `keepMounted` + `raisedKey`. |
| **gallery** | 60 cards | Lane-aware: each windowed row is one measured row of `columns` cards. |
| **icons** | 120 tiles | Lane-aware like gallery; the lane count is the probe grid's resolved track count. |
| **tree** | 100 *visible* (expanded) rows | Inside `primitives/tree`'s `TreeList`; below that the recursive render runs byte-for-byte unchanged. Uses `scrollToIndex` for selection reveal. |
| **table** | 100 rows, **ungrouped only** | Grouped mode is never windowed — it targets bounded, sectioned lists — and uses grid-flow spacers rather than absolute positioning, so the subgrid's column tracks stay aligned. |

Background: `research/2026-06-18-data-view-row-virtualization.md` and
`research/2026-06-18-tree-view-virtualization.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Notion-like multi-view data surface: one typed field schema rendered through swappable views with per-view sort/search/filter.
- Web:
  - Slots:
    - `DataViewSlots.View`
    - `DataViewSlots.FieldExtension`
    - `DataViewSlots.RowOrder`
    - `DataViewSlots.Setting`
    - `DataViewSlots.Control`
    - `DataViewSlots.Cell`
    - `DataViewSlots.CellEditor`
    - `DataViewSlots.Filter`
    - `DataViewSlots.ValueCodec`
    - `DataViewSlots.Grouping`
    - `DataViewSlots.ColumnConfig`
  - Slot contributors: 41 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `DataViewSlots.Cell` ×10
    - `DataViewSlots.Filter` ×7
    - `DataViewSlots.CellEditor` ×6
    - `DataViewSlots.View` ×6
    - `DataViewSlots.Grouping` ×3
    - `DataViewSlots.ValueCodec` ×3
    - `DataViewSlots.Setting` ×2
    - `DataViewSlots.ColumnConfig` ← `fields.enum.column-config`
    - `DataViewSlots.Control` ← `primitives.data-view`
    - `DataViewSlots.FieldExtension` ← `primitives.data-view.custom-columns`
    - `DataViewSlots.RowOrder` ← `primitives.data-view.view-order`
  - Contributes: 67 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.WebRegister` ×59
    - `DataViewSlots.Control` ×3
    - `DataViewSlots.Setting` ×3
    - `IdKinds.Kind` ×2
  - Uses: 84 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×11
    - `primitives/data-view/view-core` ×8
    - `network/live` ×6
    - `primitives/live-state` ×5
    - `primitives/css/control-panel` ×4
    - `primitives/slot-render` ×4
    - `config_v2` ×2
    - `primitives/collapsible` ×2
    - `primitives/css/overlay` ×2
    - `primitives/css/row` ×2
    - `primitives/css/sticky/stack` ×2
    - `primitives/css/sticky` ×2
    - `primitives/cursor-pagination` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/latest-ref` ×2
    - `primitives/loading` ×2
    - `primitives/search` ×2
    - `primitives/sortable-list` ×2
    - `fields.Fields`
    - `ids.IdKinds`
    - `primitives/css/fill.fillClasses`
    - `primitives/css/inline.Inline`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.ToggleChip`
    - `primitives/css/yield.yieldClass`
    - `primitives/dom/auto-scroll.KeepAnchorAcross`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/dom/in-view.createInViewWatcher`
    - `primitives/icon-button.IconButton`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/overlay/tooltip.WithTooltip`
    - `primitives/row-actions.RowActions`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (types):
    - `CellContributionMeta`
    - `CellEditorProps`
    - `ColumnConfigDerive`
    - `ColumnConfigProps`
    - `CreateOption`
    - `DataViewAggregateConfig`
    - `DataViewContribution`
    - `DataViewControlContribution`
    - `DataViewControlsContextValue`
    - `DataViewControlSummary`
    - `DataViewDensity`
    - `DataViewFoldLines`
    - `DataViewId`
    - `DataViewPageNotice`
    - `DataViewPaging`
    - `DataViewPagingTotal`
    - `DataViewProps`
    - `DataViewRenderProps`
    - `DataViewRowEntry`
    - `DataViewSection`
    - `DataViewSettingContribution`
    - `DataViewSourceBundle`
    - `DataViewSourceContribution`
    - `DataViewSourceProps`
    - `DataViewSources`
    - `DataViewViewportSink`
    - `FieldCellProps`
    - `FieldDef`
    - `FieldExtensionContribution`
    - `FieldExtensionProps`
    - `FieldExtensions`
    - `FieldExtensionsDescriptor`
    - `FieldGrouping`
    - `FieldGroupingSet`
    - `FieldOption`
    - `FieldValue`
    - `FilterConjunction`
    - `FilterController`
    - `FilterFieldValue`
    - `FilterGroup`
    - `FilterLowerContext`
    - `FilterNode`
    - `FilterOperator`
    - `FilterOperatorSet`
    - `FilterPreset`
    - `FilterRule`
    - `FilterValueInputProps`
    - `FoldRule`
    - `GlobalRowOrderContribution`
    - `GlobalRowOrderProps`
    - `GridLine`
    - `GridPhase`
    - `GroupBucket`
    - `GroupByController`
    - `GroupByRule`
    - `GroupedSectionsProps`
    - `GroupingPlanContext`
    - `GroupingRegistry`
    - `HierarchyConfig`
    - `ItemActionContribution`
    - `ItemActionProps`
    - `ItemActions`
    - `ItemActionsDescriptor`
    - `ItemActionZone`
    - `LeadingSlotProps`
    - `LivePagesPaging`
    - `LoweredFilter`
    - `ManualOrderConfig`
    - `MergedDataViewProps`
    - `PartitionOptions`
    - `RowTone`
    - `SectionBodyProps`
    - `SelectionConfig`
    - `SortController`
    - `SortPreset`
    - `SortRule`
    - `TableCellProps`
    - `ValueCodec`
    - `ViewState`
  - Exports (values):
    - `applyFilter`
    - `ChipSelectFilterInput`
    - `DATA_VIEW_HEADER_OFFSET_VAR`
    - `DataView`
    - `DataViewGroupHeader`
    - `DataViewSlots`
    - `defineDataView`
    - `defineDataViewSources`
    - `defineFieldExtensions`
    - `defineItemActions`
    - `EditableCell`
    - `FieldCell`
    - `FilterValueInput`
    - `getDataViewDescriptor`
    - `GroupedSections`
    - `IDENTITY_CODEC`
    - `IDENTITY_GROUPING`
    - `IDENTITY_GROUPING_SET`
    - `isFilterGroup`
    - `isGroupableField`
    - `leadingSlot`
    - `liveDataSource`
    - `makeSortComparator`
    - `MergedDataView`
    - `MissingDataCellError`
    - `partitionIntoSections`
    - `pickLeadingField`
    - `pickPrimaryField`
    - `readFallback`
    - `resolveBodyFields`
    - `rowToneClass`
    - `SectionBody`
    - `UNGROUPED_FOLD_KEY`
    - `useDataViewControls`
    - `useDataViewSections`
    - `useFieldIdentities`
    - `useFilterClock`
    - `useFilterController`
    - `useFlatRows`
    - `useGridPhase`
    - `useGroupByController`
    - `useGroupingClock`
    - `useGroupingRegistry`
    - `useIsChipField`
    - `useItemActionZones`
    - `useLivePagesPaging`
    - `useResolveCell`
    - `useResolveCellEditor`
    - `useResolveColumnConfig`
    - `useResolveColumnDerive`
    - `useResolveGroupings`
    - `useResolveOperatorSet`
    - `useResolveValueCodec`
    - `useRowFilter`
    - `useSortController`
- Server:
  - Contributes: 61 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.Register` ×59
    - `ids.kind` ×2
  - Uses:
    - `config_v2.getConfig`
    - `config_v2.watchConfig`
    - `ids.IdKinds`
    - `primitives/data-view/view-core.buildViewConfigRegistrations`
    - `primitives/data-view/view-core.viewsDescriptor`
    - `ui/icons/sprites.defineSavedIconSource`
  - Exports (values):
    - `readDataViewConfigDoc`
    - `watchDataViewConfigDoc`
- Core:
  - Uses:
    - `ids.defineIdKind`
    - `ids.IdOf`
  - Exports (types):
    - `CellEditorProps`
    - `ColumnConfigDerive`
    - `ColumnConfigProps`
    - `CreateOption`
    - `DataViewActiveChrome`
    - `DataViewAggregateConfig`
    - `DataViewBaseProps`
    - `DataViewDataOrigin`
    - `DataViewDeclaredSection`
    - `DataViewDensity`
    - `DataViewFoldLines`
    - `DataViewGroupHeaders`
    - `DataViewId`
    - `DataViewInMemoryOrigin`
    - `DataViewLiveOrigin`
    - `DataViewPageNotice`
    - `DataViewPagePlaceholder`
    - `DataViewPagePlaceholders`
    - `DataViewPaging`
    - `DataViewPagingTotal`
    - `DataViewProps`
    - `DataViewRenderProps`
    - `DataViewRowEntry`
    - `DataViewRowsCollection`
    - `DataViewRowsComplete`
    - `DataViewSearch`
    - `DataViewSection`
    - `DataViewSectioning`
    - `DataViewSectionPaging`
    - `DataViewSurfaceChrome`
    - `DataViewToolbarSpec`
    - `DataViewViewportSink`
    - `DataViewVisibleRows`
    - `FieldDef`
    - `FieldExtensionProps`
    - `FieldExtensionsDescriptor`
    - `FieldGrouping`
    - `FieldGroupingSet`
    - `FieldOption`
    - `FieldOptionsResult`
    - `FieldSchemaSection`
    - `FieldValue`
    - `FilterConjunction`
    - `FilterFieldValue`
    - `FilterGroup`
    - `FilterLowerContext`
    - `FilterNode`
    - `FilterNodeId`
    - `FilterOperator`
    - `FilterOperatorSet`
    - `FilterPreset`
    - `FilterRule`
    - `FilterScope`
    - `FilterScopeAccessors`
    - `FilterValueInputProps`
    - `FoldRule`
    - `GroupBucket`
    - `GroupByRule`
    - `GroupingPlanContext`
    - `HierarchyConfig`
    - `HostedToolbar`
    - `HostedToolbarForms`
    - `HostedToolbarParts`
    - `ItemActionProps`
    - `ItemActionsDescriptor`
    - `ItemActionZone`
    - `LiveDataSource`
    - `LiveDataSourceOf`
    - `LiveFacetColumn`
    - `LiveSearchableColumn`
    - `LiveSourceScope`
    - `ManualOrderConfig`
    - `PresetId`
    - `RowTone`
    - `SectionCount`
    - `SectionsToolbar`
    - `SectionsToolbarForms`
    - `SelectionConfig`
    - `SortPreset`
    - `SortRule`
    - `TableCellProps`
    - `ToolbarArrangement`
    - `ToolbarPartForms`
    - `ToolbarParts`
    - `ValueCodec`
    - `ViewState`
  - Exports (values):
    - `atLeastCount`
    - `compareValues`
    - `DATA_VIEW_HEADER_OFFSET_VAR`
    - `defineDataView`
    - `exactCount`
    - `FilterGroupSchema`
    - `filterNodeIdKind`
    - `FilterNodeSchema`
    - `FilterRuleSchema`
    - `formatSectionCount`
    - `IDENTITY_CODEC`
    - `isHostedToolbar`
    - `isSectionsToolbar`
    - `optionDescendants`
    - `orderFieldsBySection`
    - `presetIdKind`
    - `scopeFilterRows`
    - `SHARED_FIELD_SECTION`
    - `splitFieldSections`
    - `UNGROUPED_FOLD_KEY`
- Cross-plugin:
  - Imported by: 91 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `fields` ×30
    - `apps` ×22
    - `debug` ×11
    - `primitives` ×8
    - `conversations` ×7
    - `tasks` ×4
    - `infra` ×2
    - `apps-core/app-launcher`
    - `config_v2/settings`
    - `history/dialog`
    - `page/links`
    - `runs`
    - `shell/notifications`
    - `ui/theme-engine/theme-gallery`
- Exemptions:
  - Exempts itself from:
    - `data-view/no-adhoc-row-list` — `.` (sanctioned)
    - `live/visible-range-minter` — `web/internal/pages-viewport.ts` (sanctioned)
  - Exempted by:
    - `primitives/data-view` (0 debt)
    - `primitives/tree` (0 debt)
    - `reorder/editor` (0 debt)
- Test helpers:
  - Web: `@plugins/primitives/plugins/data-view/web/testing`
    - `consumerPaging` — A consumer's paging (`DataViewProps.paging`): placeholders before and after the rows, every viewport report pushed to `reports`, nothing to grow.
    - `describePagedConformance` — The paged-view contract every DataView view honours, run against `view` mounted through the real body on a laid-out page (`mountPagedDataView`):
    - `lowerFilterGroup` — Lower a DataView `FilterGroup` into a filter-language `Filter`, each rule through its operator's `lower` with `ctx.column` = the field id.
    - `lowersToMatch` — Does a rule `op(operand)` keep a row whose field projects to `value`? — the in-memory evaluator's exact path for one rule: `op.lower` over a column of `domain` (an incomplete rule, `undefined`, keeps every row), the DataView domain adapter, then the filter language's `matchesFilter`.
    - `mountPagedDataView` — Mount ONE view of a paged DataView against a laid-out page — through the real seam (`DataViewShellFrame` around `DataViewBody`, the body every DataView renders), with a fake one-instance view model, inside a scroller whose `scrollTop` the test drives and an IntersectionObserver that answers from the layout, as a browser does.
    - `PAGED_VIEWPORT_PX` — The scroller's visible height.
    - `renameColumns` — Rename every clause's column through `rename` (field id → column name).
    - `resolveLiveFields` — Resolve a schema against a live source — and check it where it is declared.
    - `testField` — A minimal option-less field for a test that calls `op.lower` directly.
    - Types: `PagedDataView`, `PagedLayout`, `PagedViewUnderTest`
- Sub-plugins:
  - **`capsule-toolbar`** — Capsule toolbar arrangement for the data-view primitive: the collapsed view chip, a borderless search field (focused by /), the control triggers as circles and a round filled create button, all in…
  - **`custom-columns`** — User-defined custom columns for any DataView: the config-backed definition controller, the per-row values live hook + upsert mutation, and the toolbar settings (Fields) button. Persists per-row…
  - **`floating-toolbar`** — Floating toolbar arrangement for the data-view primitive: the band floats over the view (a full-bleed map under it) — the view tabs as a floating card top-left, past the surface's aside, and search…
  - **`gallery`** — Gallery view child for the data-view primitive: a responsive card grid with a field-driven default card plus a composable DataCard chrome.
  - **`icons`** — Icons view child for the data-view primitive: a centred launcher grid of fixed-size tiles (the row's leading avatar filling a squircle) with the name underneath, drag-to-reorder in manual order.
  - **`list`** — List view child for the data-view primitive: a compact single-row-per-item list (Row primitive) with field-driven label/subtitle/trailing, active-row highlight, and hover item actions.
  - **`map`** — Map view child for the data-view primitive: every row with a location as a pin on a full-bleed map, clustered, with clicking a pin activating its row.
  - **`table`** — Table view for data-view: maps the typed field schema to data-table columns with host-controlled sort.
  - **`tree`** — Tree view child for the data-view primitive: adapts the shared field schema + hierarchy config onto the tree primitive (buildTree, TreeList, RowChrome, RenameInput).
  - **`view-core`** — Type-agnostic named-view-instance engine: instance model + resolver, config-descriptor machinery, debounced write-back, and the editable view-switcher chrome. Type-agnostic named-view-instance…
  - **`view-order`** — Per-view-instance manual row order for any DataView: subscribes to the persisted (dataViewId, viewId) ranks, synthesizes a total order, and contributes the resulting ManualOrderConfig back through…

<!-- AUTOGENERATED:END -->
