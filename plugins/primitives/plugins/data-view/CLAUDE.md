# data-view

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

A Notion-like multi-view data surface. One **data source** — `rows` plus a typed
`FieldDef[]` schema — rendered through multiple **views** (gallery, table, …), each
view independently sorted / searched / filtered.

## Which surface?

| You have | Use |
| --- | --- |
| One set of rows, seen several ways (gallery, list, sorted, grouped) | `<DataView>` — views are config rows |
| Another list of the **same** records: a trash, an archive, a history, a queue, rows hidden by default | `<DataViewSwitcher>` — one view bar, each view bound to a contributed **source** ([Multi-source surfaces](#multi-source-surfaces-dataviewswitcher)). Never a second pane behind a button. |
| Rows of several **different** kinds in one list (builds + backups as runs) | `<DataView>` over a union collection ([Meta-DataView](#meta-dataview-one-list-over-sources-of-different-entities)) |
| Every view stacked at once | the `sections` toolbar ([Sections toolbar](#sections-toolbar-every-view-at-once)) |

## Architecture

- One **global `DataViewSlots.View` slot** (plain `defineSlot`, rendered via
  `renderIsolated`). Each view type is a child plugin contributing one
  `DataViewContribution` keyed by its **`type`** (`"table"`, `"gallery"`, …) —
  views are a fixed shared vocabulary, so a global slot, not a per-host factory.
- **view-type vs view-instance.** A contribution is a view-*type* (`type`, `title`,
  `icon`, `component`, optional `configSchema`). The host renders view-*instances*
  `{ id, name, type, options }`, authored in config — there is **no code-synthesized
  default**. `views={[…]}` is a whitelist of **type** ids gating the `+` add menu.
- `<DataView>` is the host: builds the `ViewModel`, owns the shared chrome, and
  renders the active view with **raw rows**. Flat views call `useFlatRows`
  (search → filter → sort); the nested table applies `useRowFilter`
  subtree-preserving, then the tree primitive's search + rank order — so
  filter/search/sort behave identically across views.

## Config mode is universal (no default mode)

Every `<DataView>` is config-backed, with zero per-consumer registration (mirrors `reorder`):

- **`defineDataView("id")`** (`core/internal/define-data-view.ts`) brands the id
  `DataViewId` (type of `storageKey`; grammar `^[a-zA-Z0-9._-]+$`, no `:`). A raw
  string cannot be passed, so every id is discoverable.
- **Codegen** (`data-views-gen.ts`) scans `web/**` for `defineDataView(...)` and emits
  `{ id, pluginId }` to `shared/data-views.generated.ts` (`data-views-in-sync`;
  `./equin build` regenerates). The config lands in the **defining** plugin's tree:
  `config/<asPath(pluginId)>/<id>.jsonc`.
- **Registration** (`{web,server}/internal/{descriptors,config-registrations}.ts`):
  one reference-stable `viewsDescriptor` per id; `useViewsConfig` resolves it via
  `dataViewDescriptors.get(storageKey)`.

### The rows' own read: `readiness`, never `emptyState` for a failure

Pass the read backing `rows` as `readiness={result}` (any `useLive` / combined
result). No `readiness` = static, ready rows.

- **Body precedence** (`web/internal/body-state.ts`):
  `server error > failed read > failed field > rule error > loading > pending field > the view`.
- `error` → `errorState` (default `<ResourceErrorInline variant="block"/>`).
- `loading` → `loadingState`.
- Only `ready` reaches the view — so `emptyState` means only "ready, zero rows".
- There is **no boolean `loading` prop** (it cannot say a read failed).

A needsMachine read's `unavailable` arm is handled by the shell (its `message`
replaces every instance); don't branch on it before a DataView. A
`DataViewSwitcher` source bundle cannot carry it (tsc).

### Config is the single source of truth (fail by default)

Displayed instances come **only** from authored `config.views` rows (view-core owns
the resolver).

- **Zero rows** → a "No views configured" `Placeholder` — but only once the config
  is **known**: `useDataViewModel` returns
  `{ ready: false } | ReadyViewModel & { ready: true }` and the shell shows
  `Loading` on the first arm.
- **Authoring is required.** The views descriptor opts into config_v2's
  **`requiresAuthoredOverride`**: `./equin build` seeds
  `config/<plugin>/<id>.jsonc` with a `// @review` marker and
  **`config:overrides-authored`** fails until it is removed (review, not mere
  presence — `{"views": []}` renders "No views configured").

### The view config row

Authored terse (`{ name, view }`); view-core's `normalizeRows` derives `id`;
**array position is the order** (no `rank`). `view` =
`{ type, sort?, filter?, …opts }`.

**Host-injected keys** (read via `viewFor` / `updateView`):

- `sort` — `SortRule[]`, priority = list order, `[]` = unsorted.
- `filter` — a `FilterGroup` tree.
- `groupBy` — a `GroupByRule`.
- `fold`, `properties`.
- `nesting` (`"nested" | "flat" | "roots"`) and `filterScope`
  (`"rows" | "roots"`, nested table only) — both written by the **Sub-items**
  settings section (a `hierarchy`, or rows that `attach`).

**Authored-only** (read by the `sections` chrome): `hideWhenEmpty`,
`description`.

**Legacy shapes** (single `{ fieldId, direction }` sort, bare `"<fieldId>"`
groupBy) migrate **on read**; the file is rewritten only when the user next edits
that key.

The origin default is `{ "views": [] }` with a stable hash, so adding a view-type
never invalidates committed configs.

**Pinned sort rules.** `SortRule.pinned: true` sorts before every user rule.

- Pins are a **prefix** of the list (invariant in `web/internal/pinned-sort.ts` —
  `splitPinned` / `normalizeSortRules`, enforced in `readSortRules` and
  `setSortRules` / `setSort`).
- Header click cycles the first *user* rule (`cyclePrimarySort`; on a pinned
  field it flips the pin's direction).
- "Clear sort" keeps pins; presets store only user rules.
- Everything that *applies* a sort iterates the one list unchanged; only editing
  paths know about pins.

Example: the file explorer pins `folders` asc.

### Adoption is enforced (`no-adhoc-row-list`)

`data-view/no-adhoc-row-list` (`lint/no-adhoc-row-list.ts`, repo-wide) bans a
`.map()` of `<Row>` for data lists. Transient chrome (menus, pickers, tab strips)
keeps `Row` with `// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>`;
the row machinery itself (view children, `primitives/tree`, `reorder/editor`) is
exempt via its own `exempt/index.ts`.

### The model, and where each piece of state lives

`useConfigViewModel`: config-authored instances, instance actions (add / rename /
duplicate / delete / reorder / options sub-form), the `EditableViewSwitcher`, and
per-instance sort/filter written **back to the config row**. Runtime edits write the
**user-global layer** (`setConfig` with no `scopeId`) — an `app:` scopeId would be
ignored by the read path until forked, silently dropping edits.

**State split** (`web/internal/use-view-ephemeral.ts` → `useViewEphemeral`):

| State | Lives in |
|---|---|
| Instance def `{ id, name, view:{ type, sort?, filter?, …opts } }` (array-ordered) | `viewsDescriptor` config row (user-global layer) |
| Active instance id | the pane URL `;view.<storageKey>` (see "Addressable views"), and localStorage `${storageKey}:active-view` (per device) |
| Tree expand map, collapsed group sections, collapsed view section (sections chrome) | localStorage `${storageKey}:view-state` (per device) |
| Search query | **sessionStorage** `${storageKey}:view-query` (per tab) |
| Unsaved edits of a drafted view (`viewEdits`) | **sessionStorage** owner `data-view.view-drafts`, keyed by `storageKey` — view-core's drafts |

- **The search query is per-tab on purpose — do not move it to `localStorage`.** A
  query surviving a restart leaves a filtered subset that reads as the view's whole
  contents. Durable narrowings are the config row's. If a query should persist,
  put it in the URL.
- **The expand map is the only home for tree collapse state — never a domain
  entity column.** Collapse is per-`(surface, view-instance, row)`; an entity flag
  makes two views fight over one value, turns a UI gesture into a DB write + live
  push + `updatedAt` bump, and expand-all cannot be bounded. `project-rows.ts`
  resolves `expanded?.[id] ?? defaultExpanded ?? false`; there is no consumer
  accessor (see `research/2026-07-28-global-tree-collapse-state-as-view-state.md`).

**Per-instance options sub-form.** A view-type's `configSchema` (`FieldsRecord`)
drives the settings popover's options sub-form (a `variantField` over
`actions.variantsFor(id)`, rendered via `FieldRenderer`; reference: map's
`locationField`). Its type picker is gated like the `+` menu (view-core's
`usableTypes`).

**Orphan hazard.**

- A row whose `view.type` names a removed view-type is **fail-soft skipped**
  (`buildInstanceFromRow`) and stays in config — reachable only by an authoring
  mistake, since every picker lists only usable types.
- A type the repo DOES provide but the bundle lacks throws
  `MissingCompanionError`; so does any cell / editor / filter / codec /
  column-config / grouping lookup that misses a provided field type — a missing
  companion is never a quiet fallback.

## Addressable views: the active view is in the URL

A DataView inside a pane puts its active view in the pane URL under
`;view.<storageKey>` (`/sonata;view.sonata.library=all`). No wiring:
`useDataViewModel` binds `usePaneViewParam(storageKey)` as view-core's
`activeViewUrl`; several DataViews in one pane each get their own key.

- **Which view shows**: pinned → URL (if authored) → device's last pick →
  `defaultView` → first (`resolveActiveId`). Unknown ids fall through.
- **The URL is derived** (view-core `activeViewUrlValue`): absent on the static
  default, the active id otherwise; stale ids are rewritten; every write replaces
  (no history entry). Selecting also writes the device store.
- **Not bound**: `pinnedView` hosts, DataViews outside every pane (menu bar,
  popovers, sidebars, dialogs), and panes with no URL part that are not the app's
  landing pane.
- **Tooling**: e2e reaches a view by path — `--path "/sonata;view.sonata.library=all"`.

## Meta-DataView: one list over sources of different entities

A list whose rows are of several KINDS (builds, releases, deploys, backups as runs)
is a plain `<DataView>` over a **union collection** (`network/live`, *Union
collections*):

- `liveCollection(key, { fields, arms: { discriminator } })`;
- one `liveArm(union, kind, { label, order, from?, pick?, fields })` per source;
- served as ONE SQL window by `serveUnionCollection` (`served.arm(arm, …)`).

Not a component of its own, and not `DataViewSwitcher` (one source at a time).
What it gets for free:

- **Shared fields** — the union's `fields`: one id across sources, filter/sort/group
  in SQL over every source.
- **Per-source fields** — `<arm>.<field>`, listed under the arm's `label` in its own
  band, in arm `order`; empty on other sources' rows. An arm declared `from` an
  entity picks fields by name and also lists every field an extension EXPOSES on
  that entity (ids `<arm>.<id>`), server-sortable/filterable with no list code.
- **The source field** — the discriminator, an enum derived by `deriveFields` from
  the arms' `FieldPresentation.Register` registrations (all installed sources).
  Declaring options for it, or a presentation reading them, throws.
- **Per-source row activation** — `DataViewSlots.CollectionRowActivation({ owner: arm,
  useActivation })` (see *Row activation is PER ROW*).

Reference: `runs` (`plugins/runs`).

## Multi-source surfaces (`DataViewSwitcher`)

One source's rows at a time — the same rows organised several ways, or several lists
of one entity (Queue / History). Mixed kinds → Meta-DataView.

`<DataViewSwitcher storageKey sources hostProps title? actions? defaultView?>` is
one surface (**one `storageKey` → one config file → one `EditableViewSwitcher`**).
Each instance binds to a source via the row's optional `source` key:

```json
{
  "id": "queue",
  "name": "Queue",
  "source": "queue",
  "view": { "type": "list" }
}
```

Chrome adapts from the active instance's fields.

- **Sources are contributed components** via `defineDataViewSources<THostProps>(id)`
  (web barrel): `{ id, title, icon, order?, views?, component }`. The component gets
  `{ hostProps, render }`, owns its data hooks, and **must always call
  `render(bundle)`** (an early `return null` makes the chrome vanish). The bundle is
  `DataViewSourceBundle<TRow>` = `DataViewProps` minus shell keys
  (`storageKey`/`title`/`actions`/`defaultView`/`views`/`density`/`aside`…).
- **`views` is static contribution metadata** — the model resolves every row before
  any source mounts. Everything dynamic stays in the bundle; code-only `viewOptions`
  re-merge as `{ ...bundle.viewOptions[type], ...instance.options }`.
- **Only the active source mounts**; switching remounts the body (`key={source.id}`).
- **Unknown `source`** → row kept in config, skipped (like an orphan type).
- **Instance ids must be unique ACROSS sources** — `normalizeRows` would suffix a
  duplicate, orphaning its `data_view_row_order` rows.
- **Presets are per-surface** (keyed by `storageKey`); a preset naming a field the
  active source lacks is excluded by dangling-fieldId guards. Don't namespace them.
- Single-source `<DataView>` is the same machinery with one implicit source (see
  view-core's CLAUDE.md).

## Hierarchy

Pass `hierarchy: HierarchyConfig<TRow>` → the **table nests its rows**
(`NestedTableView`; table child's CLAUDE.md, "Nesting"); absent → flat.

The table declares `nestsHierarchy: true`, so over a hierarchy the host applies:

- no fold (`activeSupportsFold`);
- no flat manual order (`activeSupportsManualOrder` — the `RowOrder` contributor
  is not mounted);
- and its `filterScope` decides `hideWhenEmpty` (`rootsScoped`).

`HierarchyConfig`: required `getParentId`, `getRank`; optional `getAliasParents`,
`onMove`, `onCreate`.

`hierarchy` and `paging` are exclusive on the in-memory origin (a type union), and
a live `source` refuses `hierarchy` — a tree over a paged prefix orphans children.

- **Nesting is per view (`ViewState.nesting`, Notion's Sub-items).** `nested`
  (default), `flat` (every row top-level), `roots` (only top-level rows).
  - The host decides once (`activeNests`, `data-view-body.tsx`) and passes
    `hierarchy` **only while nesting** — so a flat-drawn table is the flat table
    (fold, flat manual order, one sort, no reparent/add-child/aliases/`filterScope`).
  - `flat` adds the derived **Parent** field (`web/internal/flat-hierarchy.ts`,
    reserved `PARENT_FIELD_ID`; a consumer field claiming it throws).
  - Control: `web/components/sub-items-settings.tsx`, passed to view-core as
    `hostSettings`, offered only over a hierarchy on a nesting view type.
- **One pipeline** — `useHierarchyTree` (web barrel, `web/internal/hierarchy/`):
  1. `projectRows` (aliases minted);
  2. filter under `filterScope` (`scopeFilterRows`);
  3. stable global sort (suspends DnD);
  4. group-by over roots (descendants follow their root's section);
  5. `TreeModelArgs`, every callback alias-aware.

  Old `type: "tree"` rows upgrade via the `tree-view-to-table` migration.
- **Expand is not a `HierarchyConfig` accessor, and never can be** — there is no
  `isExpanded` / `onToggleExpanded`; collapse is the per-view map (State split).
  "Click a folder to open it" is the stateless `expandOnActivate` table option.
- **Expand-all** is reported up by the view (`reportExpandAll`) and drawn by the
  toolbar as an action control ("Action controls").
- **Tree geometry is density tokens** (`--tree-chevron-w`, `--tree-row-gap`,
  `--tree-guide-x`): a child's chevron sits under its parent's icon. Disclosure
  variant: `ui/tree-disclosure` (default `column`; Pages and file explorer pin
  `merged`). Pinned by `ui/tokens/density/core/tree-geometry.test.ts`.
- The placement's `title` is the row label; inline rename is
  `FieldDef.onEdit` on that field (`EditableTreeLabel`).
- **Aliases** (`getAliasParents`): the row also appears as a read-only leaf under each
  returned parent — navigation only; a `child` drop or add-child resolves to the
  real row.

### Placement: where each field is drawn

No view decides where a field goes, and no field says where it goes. **One
engine places every field into a view's slots**, from three layers, the most
specific winning (design: `research/2026-10-28-global-data-view-placement-engine.md`):

```text
field type (kind)  →  recipe rules  →  surface `place`  →  user's PropertyEntry.slot
```

- **Kind** — what a value IS, declared by its type (`FieldIdentity.kind`,
  `fields/core`, inherited through `extends`; a root type must declare one —
  tsc): `label`, `prose`, `instant`, `duration`, `quantity`, `ordinal`,
  `identifier`, `person`, `path`, `visual`, `flag`. A closed-set field whose
  options declare a `variant` / `tint` / `icon` is a **`state`** — the one rule
  data-view decides (`useResolveFieldKind`), naming no type. `primary: true` is
  the row's **identity**.
- **Slots** (`core/internal/placement.ts`): `lead`, `title`, `afterTitle`,
  `line2`, `trail`, `edge`, `hidden`. **Each view declares the slots it draws**
  as data (`ViewSlots`: capacity, form, kinds it takes), passes it to
  `usePlacement(fields, properties, props.placement, SLOTS)` and publishes the
  same table on its contribution (`DataViewContribution.slots`) for the slot
  editor. A slot a view leaves out is one it does not draw.
- **Recipes** (`RECIPES`, plain data): `record` (default), `log`, `timeline`,
  `inbox`, `ledger` — ordered `[kind | "identity", slot]` rules. Only the
  first state leads; the others trail (outside `log`) — a coloured enum (a
  priority, a category) is a state too, and after a title of varying length
  it would sit at a different x on every row. `afterTitle` is for a surface's
  own pins. The engine
  (`resolvePlacement`, `web/internal/placement.ts`) walks rule by rule, then
  field by field: a field takes the first matching rule whose slot the view
  draws and has room in, so a second instant falls through to its next rule.
  Unplaced fields trail. No title → the first label / prose / identifier is
  promoted.
- **A surface says one word plus sparse overrides**: `recipe`, `place` (pin a
  field to a slot — `{ updatedAt: "edge" }`; an unknown id throws, two pins on a
  one-field slot throw) and `emphasis` (never gives way first). All three are
  `DataViewBaseProps`, so a `DataViewSwitcher` source carries its own.
- **Priority** (what gives way first when narrow, from last): `emphasis`, then
  the slot's rank (`SLOT_RANK`: title > lead > edge > afterTitle > line2 >
  trail), then drawing order in the slot — never the recipe's rule order.
  Tables give `trail` / `edge` columns a drop order from it (`dropOrderOf`);
  `lead` and `title` never drop.
- **Form follows the slot** (`ViewSlots[slot].form` → `FieldCell context`):
  `glyph` in a lead draws a state's option as its icon / dot alone
  (`OptionGlyph`); `token` on a card's line; `cell` elsewhere.
- **Alignment** defaults from the kind (`fieldAlign`: quantity / duration /
  ordinal / instant end). `align` is text alignment only.
- **Time ink** (`wearsTimeInk`): the `edge` and every `instant`, wherever it
  lands (a second instant trails), wear the faint `listTimeInk` — in the list,
  the table and the tree alike, so a row's times never read in two inks.

| Slot | List / tree row | Table | Gallery card | Icons tile |
|---|---|---|---|---|
| `lead` | `Row.icon` / tree-head icon (glyph) | first column | cover (a visual) or corner glyph | the face (visual only) |
| `title` | label | title column | title | name |
| `afterTitle` | marks after the label (not the tree: trails) | stacked in the title cell | after the title | — |
| `line2` | subtitle run (2 lines when present; not the tree: trails) | stacked under the title | subtitle | — |
| `trail` | aligned trailing slots | columns | ≤ 3 tokens | — |
| `edge` | far right, faint | last column, faint | token line end | — |

## Manual order

Flat rank-based drag reordering — the flat twin of `HierarchyConfig`:

```ts
interface ManualOrderConfig<TRow> {
  getRank: (row: TRow) => Rank | null;
  // within a section
  onMove: (
    id: string,
    dest: { rank: Rank; targetId?: string; zone?: "before" | "after" },
  ) => void | Promise<void>;
  // across sections; absent ⇒ refused
  onReseat?: (
    id: string,
    dest: {
      groupKey: string | null;
      targetId: string;
      zone: "before" | "after";
    },
  ) => void | Promise<void>;
  // place keys (may not exist yet)
  onInsert?: (
    keys: readonly string[],
    dest: { targetId: string; zone: "before" | "after" },
  ) => Promise<void>;
}
```

`onInsert` is what a native `rowDrop` under `placement: "between"` reaches:
view-order ranks the keys now (`computeInsertWrites`), the consumer writes its data
afterwards.

### Two sources, one rule

1. **`DataViewProps.manualOrder`** — a **domain** order the consumer owns
   (surface-wide).
2. **The per-view-instance order** contributed through `DataViewSlots.RowOrder`
   (scoped to `(storageKey, viewId)`; `view-order`).

`cfg = props.manualOrder ?? contributedRowOrder ?? null` — consumer wins; the render
path never branches on provenance.

### Manual order is the default; a sort overrides it

- No sort → `list`/`table` render in manual order and rows drag.
- A field sort overrides it and suspends drag; clearing restores it.

So the Sort control stays visible, and the sort popover says when it shadows an
order (`manualOrderOverridden`). While active:

- each section is ordered by `getRank` (search/filter still run);
- drag via `rank-reorder` (`RankReorderProvider` + `useRankSortableItem`; `icons`
  uses `layout="grid"`);
- cross-section drops need `onReseat` (handler presence = capability); without it
  collision detection sees only the row's own section, so refusal is visible;
- **no snap-back**: `usePendingMoveOverlay` (`web/internal/use-pending-move-overlay.ts`)
  holds the dropped rank until the underlying `getRank` changes, the row disappears,
  or the returned `onMove` promise rejects — a producer only returns its promise;
- `list`, `icons`, `table` **window and drag** (`measuringAlways`, `keepMounted`,
  `raisedKey`). The table uses `DataTable.useRowDecoration`.

### The global `RowOrder` slot (cross-plugin)

A `defineRenderSlot` (`primitives.data-view.row-order`) whose contributors may claim
a row order for **any** DataView:

```ts
interface GlobalRowOrderProps {
  storageKey: DataViewId;
  viewId: string; // the ACTIVE view-instance id
  rowKey: (row: unknown, index: number) => string;
  // filter-applied, search-EXCLUDED, sort-suppressed
  rows: readonly unknown[];
  render: (order: ManualOrderConfig<unknown> | null) => ReactNode;
}
```

- Folded by `RowOrderReader` (`web/internal/row-order.tsx`), **first-non-null
  wins** in the committed reorder layout
  (`config/primitives/data-view/primitives.data-view.row-order.jsonc`).
- The reader sits **beside** the surface (renders nothing, reports in a layout
  effect) — wrapping the surface would remount band/aside/view on every view
  switch.
- `rows` excludes search so a drag under a search still resolves against the full
  ordered set.

### The `rowOrderEnabled` gate

`RowOrderReader enabled={false}` short-circuits before `useContributions()` (no
contributor, no subscription):

```ts
const rowOrderEnabled =
  // list / table only; not a table nesting a hierarchy
  activeSupportsManualOrder &&
  // domain order wins
  manualOrder == null &&
  // a live source is server-sorted
  props.source == null &&
  // a representative's rank can't stand for its members
  aggregate == null;
```

- **Group-by is deliberately not a clause** — within-section reorder is well-defined
  (the order covers the unpartitioned set); cross-section drops are refused per-drop.
- **The sort test is not here either** — it is in `manualOrderActive`
  (`cfg != null && activeSupportsManualOrder && activeState.sort.length === 0`), so
  toggling a sort doesn't tear down the contributor's subscription.

## Grouping is a field-type contribution

**data-view names no field type.** How a field's values partition is declared by its
TYPE via `DataViewSlots.Grouping` (sibling of `Cell` / `CellEditor` / `Filter` /
`ValueCodec` / `ColumnConfig`; keyed by `match`, honoring `extends`):

```ts
DataViewSlots.Grouping({
  match: "date",
  label: "Group dates by",
  groupings: dateGroupings,
});
```

### The contract (`core/internal/grouping.ts`)

```ts
interface FieldGrouping {
  id: string; // "smart" | "day" | "value" — persisted
  label: string;
  plan: (ctx: GroupingPlanContext) => (value: FieldValue) => GroupBucket | null;
}

interface GroupingPlanContext {
  now: number;
  values: readonly FieldValue[];
  field: FieldDef<unknown>;
}

interface GroupBucket {
  key: string;
  label: string;
  order: number;
  ancestors?: GroupBucketAncestor[];
  // icon / tint / swatch reach the section as ONE `DataViewSection.identity`.
  icon?: IconRef;
  tint?: ColorTokenRef;
  swatch?: string;
}

interface GroupByRule {
  fieldId: string;
  groupingId: string;
}
```

- **`plan` is two-phase** — whole-set work once per render, then per row.
- **`now` is injected, never read** (the partition is memoized). The host reads
  `useGroupingClock()` — local midnight, re-armed by one timer at the next midnight
  (not polling: the change instant is known).
- **`order` is a plain ascending ordinal**, read from whichever end the view's sort
  on the grouped field points (`DataViewRenderProps.groupOrder`, derived from
  `activeState.sort` — a live source zeroes `state.sort`).

### There is exactly one "None", and a grouping cannot mint a second

`null` from a bucketer means "not a value I can bucket": the row joins the one
"None" section, owned by the partition and **last in both directions**.

- Never build your own catch-all (a second "None"; `Infinity` order sorts first
  descending).
- `order` must be **finite** or the partition throws, naming grouping and bucket.

### Groupability is derived, not listed

`isGroupableField(field, hasGrouping)` = `field.groupable ?? hasGrouping(type)`
(`useGroupingRegistry().has`, published on the controls context because a
`Setting`'s `isApplicable` is pure).

`groupable: true` on a type without groupings uses **the identity grouping**
(`web/internal/identity-grouping.ts`, `{ id: "value" }`: one section per distinct
value, ordered by `compareValues`) — also what a legacy `groupBy: "<fieldId>"`
reads as (`readGroupBy`).

### The picker

`GroupByControl`: the field radio band, then — when the field's type offers >1
grouping — a second `ControlPanel.Section` labelled by the contribution's `label`.
`controller.setField` resolves the granularity (keep if offered, else the type's
first), so a persisted `groupingId` is always valid.

## Grouped sections: one pipeline, one chrome

`useDataViewSections` computes sections; **`<GroupedSections>`** (web barrel)
presents them. A view's grouped branch renders through it, never hand-rolled:

```tsx
sections.length === 1 && sections[0]!.key === null ? (
  renderBody(sections[0]!.entries)
) : (
  <GroupedSections
    sections={sections}
    collapsedSections={props.collapsedSections}
    setSectionCollapsed={props.setSectionCollapsed}
  >
    {(section) => renderBody(section.entries)}
  </GroupedSections>
)
```

It owns:

- the sticky containing block;
- `<StickyStack>` at `--dv-header-offset` (stacks up to 5 headers, then swap
  hand-off);
- per-section `CollapsibleProvider`;
- the header.

Headers sit on the rail via `rail-follow` — no per-view header inset.

### The group header: one rendering, its style a theme token

`DataViewGroupHeader` (web barrel) is the ONE group header (no treatment prop):
`SectionHeaderRow variant="group" disclosure="trailing" rule` — identity, label
(`groupLabelInk`), count beside it, the rule box, trailing chevron (on hover/focus
and while collapsed).

- The theme token **`groupHeaderStyle`** (`ui/tokens/data-view`, via container
  style queries) picks `caption` (default) / `rule` / `pill`.
- Pinned by `web/__tests__/grouped-sections.test.tsx`.
- The table draws the same node in its own `col-span-full` rows.

### `headerActions` — one affordance, scoped to one section

`headerActions?: (section) => ReactNode` renders in the header's trailing cluster
(the nested table's `groupFoldAction`); `null` skips the wrapper.

- It sits in a nested `<RowActions pin={null}>`, hover-revealed (the count stays
  at rest).
- No click guard needed (`RowActions` stops propagation).
- Not `hover-reveal` (that primitive defers to `row-actions` for row-action
  clusters).

**`table` is the documented exception**: its group headers are `col-span-full`
subgrid rows, so it composes `StickyStack` directly inside `data-table` (offset by
its own column header, or none under `columnHeader: "first-group"`). The nested
table partitions via `useHierarchyTree` and draws each section's slice as a
`DataTableGroup`.

## Nested sections: a grouping whose buckets form a tree

A field whose `options` form a FOREST (`FieldOption.parent`, a tag tree) groups as
nested sections (`app ▸ website ▸ homepage`). Nesting is a property of the
**buckets**: a grouping returns `GroupBucket.ancestors` (root first,
`{ key, label, order, swatch? }`); data-view names no type (`fields/tag` does it
today).

- **Partition** (`partitionIntoSections`): buckets become a forest; ancestors are
  sections even with no own rows; siblings ordered `(order × dir) || discovery`;
  pre-order output with `DataViewSection.nesting = { depth, parentKey }`. Empty
  subtrees are not emitted; "None" stays last at depth 0. Disagreeing or cyclic
  chains throw.
- **Flat where order is not ours**: `appearance` sectioning, `declared` sections and
  the nested table's group-by over roots (`flat: true`).
- **Counts roll up LAST** (`rollUpNestedCounts`, after manual order, aggregate,
  fold): own + descendants via `sumSectionCounts`; one lower bound makes ancestors
  `n+`. `entries` stay the section's own rows.
- **Render**: `visibleSections(sections, collapsed)` (core) drops sections under a
  collapsed ancestor. `GroupedSections` indents by depth (`NestedSectionIndent`:
  `--tree-indent`, guides in `--tree-guide`); a section with no own rows draws as its
  header alone. The table applies `visibleSections` and the indent (no guides).
  Collapse stays keyed by `section.key`.
- **Header**: `section.identity` before the label (chip with `icon`, else a colour
  dot from `tint` / `swatch`); depth ≥ 1 labels medium weight.
- **Body state**: a paging tail counts as hidden when its section or any ancestor is
  collapsed (`isSectionCollapsed`).

Pinned by `web/internal/use-data-view-sections.test.ts` and
`web/__tests__/grouped-sections.test.tsx` ("nested sections").

## Aggregating sections (`aggregate`)

`aggregate?: DataViewAggregateConfig<TRow>` collapses rows sharing a key into one
**representative row + `×N` badge**:

```ts
interface DataViewAggregateConfig<TRow> {
  getKey: (row: TRow) => string | null; // null = never collapsed
  // default: first in order
  pickRepresentative?: (members: readonly TRow[]) => TRow;
}
```

- **A pure pipeline step** in `useDataViewSections` for every flat view, **after**
  group-by and the manual-order sort, **within each section**.
- **Output**: one `DataViewRowEntry` with `aggregateCount` and `members`, at the
  first member's position and `key`; `section.count` is the post-collapse count.
- **Badge**: list trailing, table in the primary cell, gallery top-left `Pin`.
- Members of an entry carry its attached rows (`attach`): a child whose parent
  key is any member's hangs under the entry.
- Acting on the representative "acts on the group" only if the **consumer** maps
  it so.

## Attached rows (`attach`)

`attach?: DataViewAttachConfig<TRow>` draws a row **beneath another row of the
same view while that row is loaded** — a supervised task under its supervisor in
the Queue. A relation between loaded rows, not the source's structure (that is
`hierarchy`), so it composes with `paging`, `manualOrder`, group-by, fold and
`aggregate`:

```ts
interface DataViewAttachConfig<TRow> {
  getKey: (row: TRow) => string | null; // several rows may share one
  getParentKey: (row: TRow) => string | null; // null = top-level
  defaultExpanded?: boolean; // children open unless the expand map says otherwise
}
```

- **Resolved once** (`web/internal/attach.ts`, `resolveAttach`): a row attaches
  when its parent key is another key a held row carries and that key is
  anchored (a root, or attached itself). A parent not loaded, a self-parent, a
  cycle (and what hangs from it) ⇒ top-level — never hidden.
- **Pipeline** (`useDataViewSections`): attached rows leave BEFORE the partition,
  so they ride with their parent's section whatever their own group value and
  take no slot in its count; after rank order and aggregate,
  `hangAttached` puts them on the parent entry's `children` (first entry holding
  the key wins), each child list rank-ordered and aggregated like a section,
  nested to any depth. The fold keeps a parent whose attached row is selected.
- **A row the read pages (`paging.isPaged`) never attaches** — the host strips
  its parent key: hung far from its page it would report that page on screen
  and hold every page between live.
- **Per view: the Sub-items setting** (`ViewState.nesting`). Only a view type
  declaring `nestsAttach` (the list) receives `attach`, and only while `nested`;
  `flat` draws every row in its own section, `roots` drops the rows that would
  attach (`attachRoots`). The setting is offered when the surface has `attach`
  (`subItemsSettingsFor("attach")`); a `DataViewSwitcher` source declares it
  statically (`subItems: "attach"`, asserted against its bundle).
- **Drawing** (list): children indented under the row, outside its drag wrapper
  — never a manual-order drag source or drop target. The disclosure is in the
  row's cluster (shown at rest); open state is the expand map under
  `attachExpandKey(key)` (never the row's own key, which `detail` uses), read
  through `attachedChildrenOpen` — which also opens a parent holding the
  selected row. Exclusive with `hierarchy` and a live `source` (tsc).

## Fold: "… N more" per section (`ViewState.fold`)

A softer filter: `{ keep?: FilterGroup; limit?: number }` (`FoldRule`, core — a
union, at least one of the two) in the view row (`readFold` / `setFold`; compose
the halves with `foldRuleOf`). Rows the fold does not keep are replaced by one
**fold line** at the section's end (`… N more` / `Show less`). `keep` is the
ordinary filter language (operators, editor, `summarizeFilter`, persistence
shared). `limit` keeps each section's first N entries in the order it is drawn
(sort, manual rank, server order).

Per section, an entry is kept when it matches `keep` (absent: every entry does)
**and** fewer than `limit` entries are kept before it — "the recent ones, at most
10". An aggregate counts once.

```jsonc
"view": {
  "type": "list",
  "groupBy": "section",
  "fold": {
    "limit": 10,
    "keep": {
      "kind": "group",
      "id": "keep",
      "conjunction": "or",
      "children": [
        {
          "kind": "rule",
          "id": "recent",
          "fieldId": "updatedAt",
          "operatorId": "is-within-past",
          "value": { "amount": 30, "unit": "day" }
        }
      ]
    }
  }
}
```

Rules, each enforced in one place:

1. **Search suspends folding** (`effectiveFold`, `web/internal/fold-sections.ts`).
2. **The selected row is never folded** (`makeFoldKeep`, incl. aggregate members).
   It takes a `limit` slot; past the limit it shows anyway (`limit + 1`).
3. **An all-folded group still renders** (header + fold line).
4. **The line is always at the section's end**; opening re-inserts rows in order.
5. **Open state is ephemeral** (in memory per active view id). Never config.
6. **Paging stops behind a folded tail** (`isTailFolded` gates the observer's
   `hasNextPage` — a gate, never an unmounted sentinel, which would stall paging).
   With a `limit` it is asked about the tail's whole section, so a read stops
   once a section has loaded past its limit.
7. **The fold runs last** (`foldSections`, after partition / manual order /
   aggregation); `section.count` stays the total; `section.fold = { hidden, open }`.

**A section's body band draws its fold line**: views render entries inside
`<SectionBody section foldLines className>` (web barrel), which ends in the line
(no exported `FoldLine`).

- In the grouped path, return it from `GroupedSections`' children.
- The table puts a line-only `SectionBody` in `DataTable`'s `footer` /
  `DataTableGroup.footer`.
- A nested table gets no fold.

**The editor** is the "Fold rows" `view`-scope `Setting` (`fold-control.tsx`): a
Keep row (the filter builder over `fold.keep`) and a "Show first" number field
(`limit`, empty = none); each writes with the other half kept.

- Its filter builder is pointed at `fold.keep` by `FoldFilterScope` (nested
  `DataViewControlsProvider` overriding `filter`).
- Sub-pages must go through `useFilterPanelStack()` (`filter-scope.tsx`) or a
  nested group would edit the view's filter instead.

## Paging (`paging`)

A live `source` pages its own read. A consumer deriving rows in memory from a paged
read (the conversation Queue) passes `paging={…}` beside `rows` (`DataViewPaging`),
obtained with `useLivePagesPaging(c, query, { resetKey?, narrowBy?, total? })`.

- It reads `useLive` pages and mints the viewport together, so a read cannot page
  by a viewport nothing measures.
- Any windowed collection works (lookup-only / `all` is a tsc error).

```tsx
// paging: null until ready
const { pages, paging } = useLivePagesPaging(conversationsGone, {});

<DataView
  rows={rows}
  paging={paging === null ? undefined : { ...paging, isPaged }}
  …
/>;
```

- **`narrowBy: view`** (`web/internal/narrow-pages.ts`) lowers the view's filter
  onto the collection's columns as a WIDENING (an unbacked rule is dropped, rows are
  still filtered in memory), ANDed into `query`. `total: true` reads the narrowed
  count as `paging.total`, used only while the filter is that very tree and no search
  is typed. A narrowing naming a contributed column reads no count; search is not
  lowered.
- **The viewport (`paging.viewport`, required).** The body reports which of each
  read's rows are on screen (`DataViewVisibleRows`); internal `usePagesViewport`
  mints the branded `VisibleRange` — the only place one is minted
  (`live/visible-range-minter` lint; data-view's sanctioned exemption). No viewport →
  internal `NO_VIEWPORT`.
  - **One measurement per DataView** (`web/internal/use-visible-row-keys.ts`): one
    IntersectionObserver over every `[data-row-key]` element; published after rows
    hold still 250 ms (`SETTLE_MS`), at most 1 s (`MAX_WAIT_MS`).
  - **A measurement vouches only for the rows it saw** — keyed by an epoch of the
    reads' keys; `measuring` until a settle after commit; never an empty set with no
    marked rows drawn.
  - **A new view type must stamp `data-row-key` on its rows**, or its pages are
    never released.
  - Split per read: `isPaged` rows for a flat origin, each declared section's own.
- **Placeholders (`paging.placeholders`, required).** Released pages are
  `{ before, after }` lists of `DataViewPagePlaceholder` (`{ key, rows }`), drawn by
  `web/components/page-placeholders.tsx` with `data-row-key` + `data-page-placeholder`
  so an on-screen placeholder resubscribes its page.
  - **Where**: around the whole view only when every row is the read's (not under
    `isPaged`); a declared section's inside its `SectionBody`.
  - **Height = exactly the room its rows took** (`placeholder-heights.ts`,
    `PlaceholderHeightContext`) — so releasing a page changes no layout. Unmeasured
    rows count at the mean advance.
  - **Anchoring** the residue: the rows box is `KeepAnchorAcross`, and opts out of
    browser scroll anchoring (`overflow-anchor: none`) — browser anchoring on
    recycled virtual rows scrolled whole pages.
  - **A grid keeps its columns**: grid views use `useGridPhase` (web barrel) to pad
    `index mod columns` spacer cells while pages stand above.
  - No viewport → internal `NO_PLACEHOLDERS`.
- **The conformance harness** (`web/testing`):
  `mountPagedDataView({ view, bundle, layout })` and
  `describePagedConformance({ view, layout, windowAbove? })`.
  - **A new view type adds a `paged-conformance.test.tsx`.**
  - Deployed check: `e2e/live-pages-scroll.ts` (`--view`, `--step`, `--scroller`,
    `--width`, `--expect-placeholders`).
  - Gap: the grouped table draws no declared section's `before` placeholders
    (table CLAUDE.md, "Paged").
- `isPaged(row)` names the read's rows (absent: all), in read order — the last is the
  **tail**.
- **The next page loads only while the tail is on screen** — not folded, not in a
  collapsed section, not hidden by search/filter, and not before any paged row is
  drawn.
- **Counts**: until `complete`, `rowsComplete = { growable: isPaged, total }` —
  only a section holding a paged row reads as a lower bound ("30+").
  - A read knowing its total passes `paging.total` (`{ count, uniform? }`) for
    exact counts (ungrouped, or grouped by a `uniform` field).
  - A live source reads it itself when its collection is `count: true` — not
    under search or a filter naming a contributed column.
  - The total is dropped while search/filter could hide read rows, while loading,
    and for a section the read is split across.

## Create affordances (`creators`)

`creators?: CreateOption[]` (`{ id, label, icon?, description?, onSelect, views? }`,
core + web barrels; `onSelect` may be async) — the flat counterpart of
`HierarchyConfig.onCreate`.

- The private `CreatorsControl`: 0 → nothing, 1 → labelled `Button`, N → `+`
  menu.
- It owns one shared **busy** flag (awaits `onSelect`), so no consumer hand-rolls
  one.
- Also passed as `DataViewRenderProps.creators` (the gallery's empty-state CTA).
- `views?` names the instances whose section header offers it on a `sections`
  surface; other chromes ignore it.

## Toolbar arrangements

Parts are the host's; layout is an arrangement's.
`DataViewProps.toolbar?: ToolbarArrangement` (core) is a value the surface passes
(default `barArrangement`). The host never names an arrangement — a new one is a
new plugin (`capsule-toolbar`, `floating-toolbar`).

### The default: a flat strip (`PillsToolbar`)

```text
[title] [views: switcher strip, "+" on hover] ··· [tools: search [/] · controls · actions | create]
```

`PillsToolbar` (`web/components/toolbar/pills-toolbar.tsx`, web barrel);
`PillsToolbarProps` = `ToolbarParts` + `{ overlay?, className?, style? }`.

- **Pills are flat by default** (`toolbarPillSurface: flat`; `float` restores glass
  pills). **An overlay pill ignores the token** (keeps its glass). One
  `ControlSizeProvider size="sm"`.
- **View chips**: icon + name, active on `viewChipActiveFill`; the add-view `+`
  reveals with the strip (`viewAddReveal: hover`, still tabbable).
- **The views pill is the one cell that gives** (scrolls sideways); tools rigid; the
  row never wraps. Pinned surface → no views pill.
- **Search always visible**, trailing `/` hint while empty. **`/` focuses search in
  every wide arrangement** (host binds it via `useSurfaceShortcuts`; yields to text
  fields; compact binds nothing).
- **Create follows a divider**, only with creators (`ToolbarParts.creators` is
  `null` otherwise); `createLabel` makes the N-menu a labelled button.
- **Sizes and looks are theme tokens** (`ui/tokens/data-view`; defaults = this
  look). Type picks go through `DATA_VIEW_PICKS` + `rolePickScope` / `rolePickClass`,
  not `<Text pick>` (which would add a native `title`).
- **Narrow stage**: below `NARROW_BREAKPOINT` (760, measured, not `@container` — a
  size-contained band loses intrinsic width) the theme may narrow search / drop
  create words; no-op by default.
- **Parts** (`dataPart`, core `DATA_VIEW_PARTS`): `dv.toolbar`, `dv.views-pill`,
  `dv.view-chip` / `dv.view-chip-active`, `dv.view-add`, `dv.tools-pill`,
  `dv.search`, `dv.control`, `dv.pill-divider`, `dv.create` — compare-tool selectors.

```ts
interface ToolbarArrangement {
  id: string;
  forms: {
    search: "field" | "filled" | "bare";
    controls: "ghost" | "round";
    creators: "labelled" | "round";
  };
  component: ComponentType<ToolbarParts>;
  spaceBelow?: string; // CSS length between band and view; wide layout only
  overlay?: true; // band floats over the view — see "Floating chrome"
}

interface ToolbarParts {
  title;
  switcher: { strip; chip };
  search;
  query;
  controls;
  foldedControls;
  actions;
  creators;
  asideInset: string;
}
```

- **`forms` is data**: the host builds each part once in the asked form; an
  arrangement places nodes, never re-instantiates.
- **`switcher`**: render exactly one of `strip` / `chip` (both `null` when pinned) —
  it is the only way to manage views.
- **`search` is always rendered** (a non-empty query must stay visible); placeholder
  is `DataViewProps.searchPlaceholder`.
- **`foldedControls`**: every control behind one trigger, for an arrangement short on
  room.
- **The host keeps**: the `<Sticky>` band (`mask`, `layer="nav"`), the fade, the
  measurement and `--dv-header-offset`, `hoverRevealGroup`, control
  applicability/order, and the **compact fold** (`density="compact"` or band under
  `COMPACT_BREAKPOINT` renders it whatever the arrangement). The arrangement owns its
  row box and `rail-follow`.
- **The fade**: a zero-height `<Sticky mask="fade" layer="raised">` tail after the
  band (not the band's own fade — `nav` would wash out pinned group headers).
  `spaceBelow` is the tail's runway. No tail in compact or overlay.
- **Compact fold**: views pill (only with >1 view) + tools pill (`actions`, creators,
  the one options trigger, `CompactControls`); with nothing else the PILL reveals on
  hover (`CompactControls frame`).
- **`spaceBelow`** renders as a sibling after the sticky band (scrolls away), dropped
  in compact. Views never pad their own top for a toolbar.

### Floating chrome: `overlay` arrangements and the `aside`

For a surface whose view IS its canvas (a map; reference `floating-toolbar`, Places).

- **`overlay: true`**:
  - shell root `relative h-full`;
  - body in its own `Scroll fill isolate` (the one exception to "never owns a
    scroller");
  - band is a click-through `Pin to="top"`;
  - cards wrap in `Overlay.Interactive`;
  - `spaceBelow` ignored; compact floats too.
- **`DataViewContribution.fullBleed`**: under an overlay band a fullBleed view starts
  at the top-left under the cards; others are inset by `--dv-header-offset` and the
  aside.
- **`backdrop?: string`** — a fullBleed view type kept mounted UNDER every view (map
  keeps its camera); other views float over it as a card. **`reserve?: { right }`** —
  room the surface's own chrome covers.
- **`aside?: ReactNode`** — a host panel (`web/components/band-surface.tsx`):
  - a floating left card beside an overlay band (sizes itself;
    `asideInset = calc(md + width)`);
  - a sticky left column beside an in-flow band.

  Rendered inside a `DataViewControlsProvider` (`useDataViewControls()`).
- **`asideEnd?: ReactNode`** — the right-edge mirror, below the band; overlay only.

All rules are checked in ONE place: `web/internal/surface-chrome-rules.ts`
(`assertSurfaceChrome`):

- `aside` needs a band;
- `asideEnd` / `backdrop` need an overlay band;
- `reserve` needs a `backdrop` or `asideEnd`;
- `backdrop` needs a fullBleed type.

Hosted / sections toolbars throw on `aside`.

### View edits: drafts, the home view, and the switcher's form

`viewEdits={{ mode: "draft", home? }}` — for views that are saved filters (view-core
"Drafts"):

- **Every write to `view`** (filter, sort, groupBy, fold, properties, options) lands
  in a per-tab working copy; rename/icon/reorder/add/delete stay durable. A write
  equal to the saved value (`canonicalViewValue`, filter-node ids ignored) drops it.
- `ReadyViewModel` carries `dirtyFor`, `drafts` (`save` / `discard` / `restore` /
  `saveAsNew` | `null`), `homeViewId`, `renamingId` / `setRenamingId` — via
  `useDataViewControls().viewModel`.
- **Switching discards** the left view's copy, with an Undo toast.
- **`home`** is always first: rename/delete throw, drags clamp below it.

`switcherForm`: `"strip"` (default), `"chip"` (`strip` is `null`), `"none"` (the
surface lists views itself).

- Under drafts the chip is `DataViewViewChip` (exported; `appearance="title"`).
- Self-listing: **`DataViewViewList({ newLabel, onNew? })`**
  (`web/components/view-list.tsx`), counts from **`useViewRowCounts()`** (each
  view's filter over in-memory rows; `undefined` when rows aren't in memory).
- **`viewShortcuts`** binds ⌥1–⌥9 (`web/internal/use-view-shortcuts.ts`).

### Row hover: `hoveredRowId` / `onRowHoverChange`

For the same rows shown twice (list + map).

- Views report enter/leave and paint the `hoveredRowId` row hovered.
- A report is a **claim or a release**, `onRowHoverChange(id, hovered)` — never a
  bare "nothing hovered", since two surfaces report one pointer move in
  uncontrolled order.
- Hold the state with the map primitive's `useLinkedHover()`.

### Search with suggestions (`search.suggestions`)

A controlled `search` may carry `suggestions: { content, open, onOpenChange }` —
"search or add". The toolbar owns behaviour
(`web/components/toolbar/search-suggestions.tsx`: widens, non-modal panel, Escape /
outside-press close, ArrowDown enters). The panel can read the view
(`useDataViewControls`). Reference: Places.

## Hosted toolbar: no band

`toolbar={{ kind: "hosted", frame }}` draws **no band** — for a small list inside
someone else's chrome. The `frame` component is the header and receives
`HostedToolbarParts` (`core/internal/toolbar-arrangement.ts`):

- **`options`** — the compact fold's trigger (the only way to the controls — render
  it); hover-revealed off the DataView root, pinned while a query is typed.
- **`switcher`** — collapsed chip with >1 view, else `null`.
- **`creators`** — compact form or `null`.
- **`body`** — the rows; loading / no-views come through the same frame.
- **`stickyRef`** — attach to a sticky header so its height becomes
  `--dv-header-offset` (else `0px`).

Options and rules:

- `forms?: { switcher: "chip" | "row" }` (`row` = full-width `Row` heading line;
  reference `SIDEBAR_TOOLBAR` in `conversations-view/plugins/data-view`).
- Not an arrangement. `title` / `actions` are a **type error** beside it.
- **Declare `frame` at module scope** (new identity remounts the card).
- Config is unchanged.

## Sections toolbar: every view at once

`toolbar={{ kind: "sections", forms? }}` renders EVERY instance, stacked in config
order, each under its own collapsible header. No active instance, no switcher.
Reference: the Pages sidebar.

- **Shell**: `DataViewSectionsBody` hoists the field-extension fold (one subscription
  per surface) and mounts one `DataViewBodyInner` per instance. The model stays ONE
  hook in the shell (per-section models would overwrite each other's ephemeral
  writes).
- **Header** (`web/components/view-section.tsx`): `SectionHeaderRow` (`forms.header`:
  `eyebrow` | `group`), hover cluster with `+` (creators narrowed by
  `CreateOption.views`) and `⋯` (compact root panel for THAT view, "Section
  settings", "Add section").
- **Sticky**: each section is its own containing block; its body re-publishes
  `--dv-header-offset` as the header height.
- **Collapse** is a view-level `collapsed` flag in `${storageKey}:view-state` —
  never in `collapsedSections`.
- **`hideWhenEmpty`**: hidden while loading (never flashed) and once ready with no
  row passing the filter (same `useRowFilter` + `scopeFilterRows`); shown on error.
- **`description`**: header tooltip and first line of `⋯`.
- **`selectedRowId` is surface-level** (highlights in every section); **the reveal is
  not** — other sections get `revealSelection: false` for a row activated elsewhere.
- `title` / `actions` / `pinnedView` are type errors beside it; `DataViewSwitcher`
  takes `DataViewActiveChrome`, which lacks this arm.

## Toolbar controls

Every toolbar affordance that opens a panel — Filter, Sort, View settings — is a
**`DataViewSlots.Control` contribution**; the toolbar names none. It reads the slot
in layout order (`useSlotOrder` over `config/primitives/data-view/control.jsonc`),
drops those whose `isApplicable` says no, and builds one trigger each.

```ts
DataViewSlots.Control({
  id: "data-view.filter",
  label: "Filter",
  icon: MdFilterList,
  isApplicable: (ctx) => ctx.filter.filterableFields.length > 0,
  summary: (ctx) => summarizeFilter(…), // pure
  component: FilterControlPanel, // prop-less; reads useDataViewControls()
});
```

### Action controls: a trigger that acts

`DataViewControlContribution` is a union:

- a **panel control** — `label`, `icon`, `isApplicable`, `summary`, `component`;
- an **action control** — `action(ctx) → { label, icon, run } | null`: one pure
  function answers applicability and content; no summary, never in the badge.

`useToolbarControls` resolves both into `ToolbarControl`
(`kind: "panel" | "action"`), read by every renderer (tsc-exhaustive).

**Expand-all is the built-in action control** (`data-view.expand-all`, also a
"Rows" Setting).

- The active view reports it —
  `DataViewRenderProps.reportExpandAll({ allExpanded, changes(next) } | null)`.
- The host binds `setAll` to `viewModel.setExpanded(activeViewId, …)`.
- Reports from a view switched away from are ignored.

### A render slot the toolbar never `.Render`s

`.Render` would mount every control's panel (and its subscriptions) just to draw
a closed trigger. The host reads metadata in layout order and mounts only the open
panel (`renderIsolated`). Order is the committed layout, never a number.

### A layout not known yet is a state, never an empty list

`useSlotOrder` is a read: `loading`, `stale` on error with a known layout. Every
reader goes through `slotLayout` (`web/internal/slot-layout.ts` → `known` |
`loading` | `failed`):

| Reader | While loading | Failed, none known |
|---|---|---|
| `DataView` / `DataViewSwitcher` | the shell's not-ready placeholder (`pendingLayoutModel`); never build the model over `[]` (every row would look orphaned) | shell failure, with Retry |
| `useToolbarControls` | no triggers, no badge (compact keeps its trigger for search; first page shows loading) | no triggers; fold shows the failure |
| `SettingsControlPanel` | `Loading`, never "Nothing to configure here." | failure, with Retry |
| `RowOrderReader` | reports `pending` → body `loading` (never raw order that then jumps) | reports `failed` → body `error` |

`ReportedRowOrder` = `pending` | `known` (`order` or `null`) | `failed`; the reader
is mounted in hidden sections too.

Gap: a contributor answering `null` while its own data loads paints unsorted rows
until it lands.

`DataViewSlots.Setting` is one level down: a section inside a control's panel (the
settings control). Don't flatten settings into controls.

### One merged context

`useDataViewControls()` (`web/components/controls/controls-context.tsx`) is read by
both control panels and `Setting`s.

- Everything is computed once in `DataViewBodyInner`; `filter` / `sort` are the
  same controllers the row pipeline uses.
- Provided around **the toolbar and the `aside`** only — never the view body
  (views use `DataViewRenderProps`; no back door).

### The trigger is icon-only, everywhere

`ControlTrigger` = ghost `IconButton`, `secondary` while narrowing. No summary text,
no `+N` badge, no width-dependent form (summary pills were tried and reverted — they
ate the narrowest toolbars).

### The summary is pure, one function — and TEXT, never chrome

`summary(ctx)` → `DataViewControlSummary` (`label`, `spoken?`, `more`, `count`) |
`null`, spent on the tooltip, the accessible name, the compact fold's row text, and
`count` → the fold badge.

- **Not a hook** — a closed trigger must not mount its panel
  (`summarize-filter.ts` / `summarize-sort.ts` are plain functions).
- **One function, one object** — the summarizers use `isRuleActive` (from
  `rule-resolution.ts`), so summary, count and evaluator can't disagree.
- Operand formatting tries `FilterOperator.summarize(operand, field)` first.
- **Settings carries no summary** (configuration, not narrowing); Sort does.

### Panel bodies

- A control's `component` is **prop-less** and reads the context, mounted by
  `DataViewControlPanel({ control })` in both the bar and the compact fold. Draw with
  `control-panel` (`@plugins/primitives/plugins/css/plugins/control-panel/web`); never
  paint a surface, never declare a width.
- The settings control is always applicable (pure `isApplicable` can't read the
  `Setting` slot); renders `ControlPanel.Empty` when nothing applies.
- **A `Setting` renders its own `ControlPanel.Section`** (contract): no loose rows,
  no wrapper `div`; the host maps contributions through a `Fragment`. A setting never
  owns the panel `Footer` (Properties' "Show all fields" is its section's last row).
- **A sub-panel is a push, never a second popover** (`usePanelStack()`). A pushed
  page's `render` closure is captured at click time and replaces the root subtree, so
  **a page reads its state through hooks**, never via closure props (stale on the
  second edit).

## An option carries its own presentation

`FieldDef.options: FieldOption[]` = `{ value, label, variant?, hint? }` (core) — no
parallel value→label / value→variant maps.

- `variant`: a `BadgeVariant` (`primitives/css/badge/core` — in `core` so data
  declarations can spell it; don't duplicate it here); absent ⇒ `"muted"`.
- `hint`: the chip's tooltip.
- `value`: the canonical spelling (`fields/core`'s `optionKey`); an enum over
  booleans / numbers declares `FieldDef.valueDomain`; option `"null"` labels
  no-value (chip, "None" section via `nullGroupLabel`, filter → `isEmpty`).

Where the presentation is drawn:

- Inline editors / filter operand inputs (`ToggleChip`) stay untinted.
- In a row view (`presentation: "quiet"`) an option draws as `● label` via
  `QuietOption` (dot: `tint` → `swatch` → variant ink → faint).
- Group labels and summaries are text-only.
- Custom enum columns get no colour picker.

### The Cell registry also says whether a type presents as a chip

`DataViewSlots.Cell` contributions carry `chip?: boolean` (`CellContributionMeta`,
`web/cell-slot.ts`; `enum`, `tags` set it). `useIsChipField()` shares
`useResolveCell`'s `extends` lookup. It decides:

- the list subtitle draws ` · ` only **between two non-chip terms** (chips are
  separated by spacing);
- which fields a row view may **elide**;
- trailing-slot alignment (chip start, else end).

No field type is named. A consumer's `FieldDef.cell` override on a chip-typed
field is assumed to render a chip.

## Structured display data (`data`)

`FieldDef.value` is the scalar **comparable** projection (sort/filter/search/group);
`values` its multi-value twin; `FieldDef.data?: (row) => unknown` is **structured,
display-only** (an avatar spec).

- Read only by the type's cell (`useResolveCell` passes `TableCellProps.data`).
- Inert: nothing comparable reads it (no `value` ⇒ not sortable / groupable /
  filterable / searched). Pair with `value` if needed. It does appear in Properties.
- With no `cell` override and no type cell, `FieldCell` throws
  `MissingDataCellError` (never a blank cell).

## Row activation is PER ROW

`onRowActivate?: (row) => void` (every row) **or**
`rowActivation?: (row) => (() => void) | null` (handler presence = activates).
Both → throws.

- The handler is an `Activation` (`link-gesture/core`): `() => void` or a
  **link** `{ open, href }` — return `openPane.to(...)` for a row that opens a
  pane, so ⌘/middle-click opens a new tab.
- `link-gesture/no-click-navigate` flags a navigating plain handler.

The host folds both into ONE
`DataViewRenderProps.rowActivation: (row) => Activation | undefined`. Views:

- spread `activationProps(act)`;
- call `runActivation(act)` for keyboard paths;
- pass `activationHref(act)` to `DataTable.rowHref` / `TreeRowChrome.selectHref`.

**Pass the result straight through — `undefined` and all, never wrapped in a
closure.** `Row` infers `<button>` from `onClick`; a closure makes every row a
button with nested controls (invalid DOM).

- Locked by `list/web/__tests__/row-activation.test.tsx`.
- `DataCard` follows the same rule.
- The **table is table-level** (`DataTable.onRowClick` is table-wide).

### Open is a separate gesture (`onRowOpen`)

`onRowOpen?: (row) => void` — double-click / Enter — never folded into activation (a
file browser: click selects, double-click descends). Table maps it to
`DataTable.onRowOpen`; list / gallery / icons ignore it.

### The click belongs to the row; the pencil belongs to the field

Clicking an editable value does **not** edit: the click does the row's thing; editing
is a pencil beside each editable field, hover-revealed (`hover-reveal` classes),
focusable. `EditableCell` owns this for every view; the pencil is always mounted
(no reflow). Exception: the **nested table's primary label** keeps select-then-edit
(`EditableTreeLabel`).

### Where a row goes, declared by its owner (`CollectionRowActivation`)

`DataViewSlots.CollectionRowActivation({ id, owner, useActivation })` declares once
where a collection's (or arm's) rows go; every DataView listing the owner folds them
(`web/internal/collection-row-activation.tsx`, pure `fold-activations.ts`).

- An arm answers only its rows; two answering one row throws.
- The list's own `rowActivation` / `onRowActivate` runs **after** (`afterOpen`),
  never instead.

## Row selection, and native row drag and drop

Three props for Finder-class surfaces (file explorer), generic over `TRow`,
independent of checkbox `selection`.

### `rowSelection` — a set, not a single id

```ts
interface RowSelectionConfig {
  selected: ReadonlySet<string>; // row keys
  anchor: string | null;
  onChange(next: {
    selected: ReadonlySet<string>;
    anchor: string | null;
  }): void;
}
```

- **Controlled.** Click, ⌘/Ctrl-click (toggle — not the new-tab gesture here),
  Shift-click (range), Shift+↑/↓, ⌘/Ctrl+A, Escape — all via the tree primitive's
  one reducer `nextRowSelection` (tree/core) over rows **as painted**.
- `selectedRowId` stays the primary row; the grid says `aria-multiselectable`.
- Honoured by the nested table.

### `rowDrag` / `rowDrop` — HTML5 drag and drop, not dnd-kit

```ts
interface DataViewProps<TRow> {
  // … (excerpt)
  rowDrag?: { write(rows: readonly TRow[], dt: DataTransfer): void };
  rowDrop?: {
    accepts(row: TRow, types: readonly string[], edge: RowDropEdge): boolean;
    onDrop(
      row: TRow,
      dt: DataTransfer,
      edge: RowDropEdge,
      ctx: RowDropContext,
    ): void | Promise<void>;
    placement?: "into" | "between"; // default "into"
    background?: {
      accepts(
        types: readonly string[],
        at: { viewId: string; group: string | null },
      ): boolean;
      onDrop(
        dt: DataTransfer,
        at: { viewId: string; group: string | null },
        ctx: RowDropContext,
      ): void | Promise<void>;
    };
    dropEffect?: "move" | "copy" | "link"; // default "move"
    springOpenMs?: number; // default 700
  };
}

type RowDropEdge = "into" | "before" | "after";
type RowDropContext = {
  order: { insert(keys: readonly string[]): Promise<void> } | null;
};
```

Native because it:

- carries rows elsewhere (not a reorder);
- crosses plugins (the MIME type is the contract);
- works under any sort;
- leads to OS drag-out.

Behaviour:

- **Drag**: carries the `rowSelection` set when the grabbed row is in it. Nested table
  only, never beside `hierarchy.onMove` (throws).
- **Placement**: `"into"` rings the accepting row (`DROP_TARGET_RING`); `"between"`
  draws `DropInsertLine` in the nearer gap, never a ring. List takes either; nested
  table `into`.
- **A gap has one spelling**: `useRowDnd` resolves a gap to `"after"` the row above
  (`"before"` only for a section's first row); empty band space maps to the nearest
  end's gap. `"between"` requires `sequence: RowDndSequence` (throws without).
- **The drop lands where the line was**: under `"between"` in manual order with
  `onInsert`, `ctx.order.insert(keys)` places the keys there (insert first, then
  write data). Otherwise `ctx.order` is `null`.
- **Fall-through**: non-accepting row → `background`; under a hierarchy it goes UP to
  the nearest accepting ancestor (`DROP_TARGET_WASH`, state `"inside"`), then
  `background`.
- **Own rows cancel** (onto itself, inside itself, onto the current parent).
- `accepts` decides by MIME type; read the `DataTransfer` in `onDrop` before the
  first `await`.
- **Spring-open** (nested table): `useSpringOpen` (tree/web) opens after
  `springOpenMs`, recloses what the drop didn't land in.
- **Background**: the view's own empty box (`group: null` in the nested table, the
  section key in a list); the host binds `at.viewId`.

Plumbing:

- `useRowDnd` (web barrel; per-view store read per row by `useRowDropState`, so a
  drag re-renders only the rows it crosses), `DropBackground`, `DropInsertLine`.
- A new view spreads `dnd.rowProps(key, row)` on its ONE (`relative`) row element
  and wraps sections in `DropBackground`.
- Nested-table and tree-chrome rows are `select-none`.

## Row tone: a row can read as inactive

`DataViewProps.rowTone: (row) => "default" | "muted"` — `"muted"` dims the row's
title (switched-off / archived / done).

- A data accessor, it flows like `searchAccessor` (bundle → body →
  `DataViewRenderProps.rowTone`), not the chrome path.
- Views render it only via `rowToneClass(tone)` (web barrel).

| View | Where |
|---|---|
| list | the title `<Text>` (one-line and stacked) |
| gallery | card title (`CardMeta titleClassName`), cover veiled (`DataCard dimmed`) |
| nested table | the label class, before `options.labelClassName` |
| flat table | **deliberate no-op** (its one per-row seam, `useRowDecoration`, is held by drag) |

Prefer `rowTone` over the nested table's `labelClassName` / `rowAccent` escape hatch.

## Density: how much room the surface gives the view

`density`: `"comfortable"` (default) | `"compact"` — a declaration by the surface,
along one path:

```text
DataViewProps.density (and switcher's)
  → DataViewShellChrome.density (web/internal/body-types.ts)
    ├→ toolbar (the fold rule)
    └→ DataViewRenderProps.density
```

`DataViewSourceBundle` omits it. What each view tightens:

- list: default row size `sm` vs `md`;
- table: `DataTable density` (`py-row-compact`);
- gallery: narrower card min (`--gallery-card-min-compact`).

## Table view options

`viewOptions={{ table: { … } }}` is `TableViewOptions` (table child's `core`):

- **`columnHeader?: "row" | "first-group"`** — `"first-group"` puts the column labels
  on the first group header (a subgrid row, sort-on-click kept); falls back to
  `"row"` when ungrouped or the first column is labelled.
- **`FieldDef.header?: string | false`** — column header text (default `label`);
  `false` leaves it empty but keeps `label` in pickers.
- **`presentation: "soft"`, `cover: true`** — the soft table (table child's
  CLAUDE.md). The title column stacks its `afterTitle` and `line2` fields
  whenever the placement gives it any.
- **Column captions** —
  `configSchema: { columnCaptions: "auto" | "shown" | "hidden" }` in every table
  view's settings.
  - Resolved once (`web/internal/column-captions.ts`, `tableHeaderOption`):
    `shown`/`hidden` win, `auto` → `header ?? presentation !== "outline"`.
  - Three-way on purpose (a switch has no "default" position).
  - The list's `columnCaptions` is a plain switch (default off).
- **Label look is the theme's** for every `DataTable`: `columnHeader*` tokens and
  `sortIcon` (`hover` default / `sorted` / `always`).
- Under `presentation: "outline"` the nested table mounts `FieldPresentationProvider`
  (quiet, elided — like a row view); grid and soft tables never do.
- `density` is honoured.

### The fold rule

```ts
const compact =
  density === "compact" || (width > 0 && width < COMPACT_BREAKPOINT);
```

OR-ed, never substituted: below `COMPACT_BREAKPOINT` (360px) the wide row doesn't fit
whatever the declaration; `compact` asks for the light form even with room.

### The compact trigger is hover-revealed

The **toolbar row** carries `hoverRevealGroup`, the trigger `hoverRevealTarget` (the
CSS half of `primitives/hover-reveal` — never `useHoverReveal()`, which re-renders
the whole DataView per hover). The group is on the **bar**, not the root (else
grazing rows flickers the control).

```ts
const alwaysVisible = open || searching;
```

**Only the query pins it — filter, sort and group-by do not**: those are durable
narrowings that define the view; a query is ad-hoc and otherwise leaves no trace.
(Pinning on `activeCount > 0` never hid; a `hidesRows` summary flag was removed —
don't re-add either.)

- The badge still counts filter and sort.
- One fold, one behaviour everywhere.
- **The bar stays in flow** (reserves its height); with only the trigger, the pill
  itself reveals (`CompactControls frame`).

### Single-line list rows are the default

`ListViewOptions.lines`: `1` | `2` — default `2` when the placement puts a
field on `line2`, else `1`.

- At `1` the title and subtitle are sibling truncating leaves of the row's
  `Line`, an empty `<Fill>` before the rigid trailing cell.
- At `2` the subtitle stacks (each `<Text>` asks for `truncate`).
- Both shrink by content width — no shrink-priority primitive.

**Trailing fields sit in aligned slots**: each slot's `min-width` is
`var(--list-slot-w-<i>)`, the widest seen.

- One `useResizeObserverSet`, written as a CSS var on the `display: contents`
  root — no row re-renders; no subgrid because `VirtualRows` positions
  absolutely.
- Widths only grow; reset when the trailing set changes. Gap: `listSlotGap`.
- The **`edge`** field goes last, in `listTimeInk`.

**Column captions** (list `configSchema`, default off): a caption row aligned to the
same slots.

Surfaces overriding `viewOptions.list.renderRow` are unaffected.

## Quiet rows and common-value elision

A row view (list; nested table under `outline`) mounts
`FieldPresentationProvider({ rows, fields, rowsComplete })`
(`web/internal/field-presentation.tsx`); the **table never does**. Outside a
provider: chip presentation, nothing elided.

- **Quiet**: cells get `TableCellProps.presentation: "quiet"` — enum/tags draw
  `● label` (`QuietOption`).
- **Common-value elision**: a value held by **≥ 60%** of rows is left out.
  - A scalar draws nothing — a list slot keeps its width, a subtitle term is
    dropped with its separator (`isElidedRead`); a multi-value draws its other
    values.
  - Guards in `computeElided`: only passed term fields that present as chips and
    are not editable; no row may have the field empty; only when
    `rowsComplete === true`; never below 3 rows.
  - Population = the view's `rows` (not search results).
  - Context identity is stable while the answer is unchanged.

## Per-item actions

Contribute an action once; every view draws it in its trailing affordance.

- **Mechanism**: the **`defineItemActions<TRow>(id)` factory** (web barrel) —
  per-consumer slots, not a global one, because row types are disjoint (a global
  slot would need `unknown` + a runtime discriminator).
- The result is callable for contributions (`MyActions({ id, component })`) and
  carries `.Row`; pass `<DataView itemActions={MyActions} />`.
- Components receive `ItemActionProps<Row>` = `{ row, hasChildren, placement }`.

### The zone axis: does this action live at rest?

`zone?:`

- `"revealed"` (default) — the hover cluster;
- `"persistent"` — painted at rest;
- `"primary"` — THE main verb; at most one per set (a second throws).

Plus optional `useActive?: Hook<(row) => boolean>`.
`placement: "cluster" | "primary"`.

**The rest rule** (`web/internal/item-action-rest.ts`, `itemActionRests`):

- `persistent` rests unless it declares `useActive` (then only while active);
- `revealed` / `primary` rest only while active — except a `primary` demoted to
  the cluster, which always rests.

Each action is an `ItemActionCell`.

Views call `useItemActionZones(itemActions, { hasPersistentSlot, hasPrimarySlot })`
(both **required** — a new view must answer) →
`{ cluster: { atRest, revealed }, primary: { atRest, revealed } | null }`.

- No persistent slot ⇒ everything in `cluster.revealed` (demoted, **never
  dropped**).
- No primary slot ⇒ the primary joins the cluster and always rests.

| View | `hasPersistentSlot` | `hasPrimarySlot` | At-rest placement |
|---|---|---|---|
| gallery | `true` | `true` (round button, cover bottom-right) | cover top-right float chip (`DataCard.actions.atRest`) |
| table | `true` | `false` — `true` with `cover: true` | the reserved trailing `auto` track |
| nested table | `true` (`false` for `outline`) | `false` | the row's trailing cell |
| list | `false` (keeps title width in narrow sidebars) | `true` while the row shows a cover thumbnail | — demoted to the hover cluster |
| icons | `true` | `false` | tile top-right float chip |

`CollectionItemAction`s are always `revealed`. **`primitives/action-presentation` is
a different axis** (what form an action draws as) — compose, don't merge.

## Field extensions

**There is no second per-row render slot — a per-row datum is a `FieldDef`** (which
also buys sort, filter, a column).

- **Browser-only values** (git status, usage) are **client fields**
  (`network/live`, "Rows that are not database data").
  - Declared in core: `clientFields(owner, id, { section?, fields })`.
  - Resolved by the plugin's web: `ClientFields.Resolve({ fields, component })`.
  - `CollectClientValues` (`web/internal/derived-fields.tsx`) mounts the
    resolvers: loading → `pending`, failed → `readError`.
  - In-memory only (a live `source` listing such an owner throws).
  - Non-DB rows name their `rowKind` as the in-memory `collection`.
- **Per-row data another plugin owns** is an entity-extension exposure
  (`defineExtensionShape({ exposes })`), derived on every list reaching the entity and
  server-sortable/filterable.
- **User-defined** fields: the global **`DataViewSlots.FieldExtension`** slot
  (custom-columns), plus a registration-level `section: string | null`:

```ts
interface FieldExtensionProps<TRow> {
  storageKey: DataViewId;
  rowKey: (row: TRow, index: number) => string;
  render: (fields: FieldDef<TRow>[]) => ReactNode;
}
```

**Derived fields come before the fold, with no contributor.** A list over a
collection declared by fields (`liveCollection({ from, pick, fields })`,
`network/live` "Fields") DERIVES its schema (`deriveFields` / `listSchema`), in
order:

1. the collection's own fields (enum when options are declared; string array →
   `values`);
2. exposed fields of every reached entity (`from`, `related`);
3. union arm fields (`<arm>.<field>`, under the arm's `label`, in arm `order`);
4. the owner's client fields;
5. each presented by its owner's `FieldPresentation.Register`:
   - `cell`;
   - `token` → `FieldDef.token`;
   - `extent: true` → `FieldExtentsContext` `{ min, max }` per view;
   - `width`, `align`, `visible`, `groupable`;
   - `useOptions` — a live read makes the field `pending` until options land.

   A property set by both a picked field's collection and its entity throws;
6. else the type's `DataViewSlots.Cell`.

- **Hand `fields` over DB rows has no spelling** (tsc): rows from `useLive` /
  `useLiveRow` are `CollectionRow`, refused by the hand-`fields` arm — use
  `collection=`. Pinned by `core/internal/data-origin-types.test.ts`,
  `web/internal/body-types.test.ts`.
- A list then says only what it changes:
  `overrides={fieldOverrides(collection, { status: { groupable: false } })}`
  (unknown id: tsc error + throws) and `extraFields`.
  - Hand `fields` beside a collection throws; neither throws; duplicate ids
    throw.
  - Only a live source binds exposed/arm `column`s (exposed groupable columns
    group as server sections).

**A field's own read: `pending` and `readError`, never a stand-in value.**

- `pending: true` while loading with nothing held → cells draw loading, and a view
  that groups / sorts / filters / folds by it (`fieldsReadByView`, the fold IN
  EFFECT) renders its loading state.
- `readError` once failed with nothing held → cells draw the failure with Retry; a
  view laid out by it shows `field-error`.
- A failure over held values keeps painting them.

(Case: the task list's `category`.)

**One fold.** `CollectFieldExtensions` (internal) is a recursive **component**
(never a `.map` over hooks) folding every contributor (`renderIsolated`) into
`children([...base, ...allExtra])`.

- It wraps the model **before** the sort/filter controllers so contributed fields
  appear in Sort, Filter and columns.
- Runs at `<unknown>` (cast at the top-level boundary).
- Order: committed layout
  `config/primitives/data-view/primitives.data-view.field-extension.jsonc`.

### Field sections: a band per contributor

`FieldDef.section` is the heading a field is listed under in every field picker
(filter/sort typeahead, Properties, group-by): host fields under
`SHARED_FIELD_SECTION` ("Common"), contributors under their own names.

- **A contributor never authors it per field**: declared once on the registration
  (or client-fields declaration) and **stamped** by the fold (`sectioned()` in
  `field-extensions.tsx`). Hand `FieldDef.section` is for a host splitting its own
  schema.
- **Required and nullable**: `null` = "ordinary host fields", distinct from forgetting.
- **Headings only with >1 section** — `FieldSections`
  (`web/internal/field-sections.tsx`), using `ControlPanel.Subhead`.
- **The typeahead matches the band's name** (`fieldSearchText`).
- **Band order IS body order** — `orderFieldsBySection` (core) in both
  `resolveBodyFields` and Properties (one `SortableList` per band); columns from two
  sources cannot interleave.

## Collection-consumer separation

Consumers import **only** `DataView` + core types and pick views by **type** id
(`views={["gallery", "table"]}`); they **never** import a view child. A new view type
is a new child plugin with zero consumer changes.

## Adding a new view child

1. Create `plugins/primitives/plugins/data-view/plugins/<view>/`.
2. In `web/index.ts`:
   `DataViewSlots.View({ type: "<view>", title, icon, component, … })`.
   - `component: ComponentType<DataViewRenderProps<unknown>>` receives **raw**
     `rows`, `fields`, `rowKey`, `ViewState`, bound `setSort` / `setFilter`,
     activation, `searchAccessor`, `hierarchy` (only while nesting), opaque
     `options`, `emptyState`, … and applies its own processing (`useFlatRows`).
   - Re-cast from `unknown` at the component boundary.
3. Obligations:
   - stamp `data-row-key` on rows;
   - answer `useItemActionZones`' two flags;
   - add a `paged-conformance.test.tsx`;
   - render grouped sections through `GroupedSections` / `SectionBody`.
4. `./equin build` — the registry is generated from the filesystem.

## Filtering

`FieldDef.type` drives filtering: the Filter panel writes a `FilterGroup` to
`state.filter`, evaluated through the ONE filter language (`network/live/plugins/filter`):

- **Operators lower, they do not predicate.**
  - A type's `FilterOperatorSet` (`useResolveOperatorSet`, honouring `extends`)
    declares a `domain` (`text` / `number` / `boolean` / `instant` /
    `stringArray`).
  - `FilterOperator.lower(operand, { column, now })` returns a language `Filter`,
    or `undefined` for an INCOMPLETE rule — the one answer both the evaluator and
    `isRuleActive` read.
  - Negative operators lower to complement ops, so they KEEP rows with no value.
- **`lowerFilterGroup(group, fields, resolveOperatorSet, now)`**: dangling/incomplete
  rules and empty groups are TRUE. Returns `{ filter, readsClock, unavailable }`;
  relative time is lowered here to ISO instants (the language has no clock).
- **A dangling rule is reported, never silently dropped.** `useRowFilter` returns
  `all` | `match` | `unavailable`.
  - The body refuses to render while the in-memory filter or the fold in effect
    names one: loading while the deferred plugin tier loads (the contributor may
    not have registered yet), then the `rule-error` arm with **Remove**
    (`pruneRules`).
  - A live source's `UnavailableFilterRuleError` / `UnavailableSortRuleError` is
    the same arm.
  - Views read the predicate via `bodyRowMatcher`; callers outside the body
    handle `unavailable`.
- **In memory**: lower once, `matchesFilter` per row; values coerced by ONE adapter,
  `coerceToDomain`.
- **Day rollover**: `useFilterClock(readsClock)` — midnight timer only while the
  filter reads the clock.

The nested table applies it subtree-preserving; the fold's `keep` uses the same
`useRowFilter`.

### A source's filter: nothing falls back to the client

`web/internal/live-filter.ts`:

- **A saved rule the source cannot run** (column not filterable / gone, operator
  gone) is refused (`UnavailableFilterRuleError`, sort likewise) — never silently
  run partially. Incomplete rules are not errors.
- **`useViewFilter`** lowers the view's group against `useFilterClock`;
  **`lowerSearch`** → `or(contains(col, q) …)` over `searchable` columns.
- **Over the language's bounds** (depth 4, 50 clauses, 100 list values):
  `canonicalizeFilter` throws `FilterError` → error in place of the view, never
  trimmed.

Test an operator lowering with `lowersToMatch(op, domain, operand, value, now?)` from
`@plugins/primitives/plugins/data-view/web/testing`.

**Filter presets** twin sort presets: named `FilterGroup`s in the `filterPresets`
key of the same config doc (via the `presetsExtraFields` seam).

- Drawn by `web/components/presets/`; delete raises an Undo toast.
- Hook `useFilterPresets(storageKey)`; readers `readFilterPresets` /
  `filterPresetMatchesGroup`.

### Live sources (`source`): a `network/live` collection as live key-range pages

`DataViewProps` is a union — exactly ONE origin (no `rows={[]}` stand-in):

- `{ rows; readiness?; rowKey; fields | collection }` — in memory;
- `{ source }` — `liveDataSource` (web), read as `useLive` key-range pages. Refuses
  `rowKey` (key = collection `id`), `hierarchy`, `manualOrder`, `searchAccessor`
  (search is `searchable`); `RowOrder` stays off. `DataViewSourceBundle` is a
  DISTRIBUTIVE `Omit` (pinned by `web/internal/body-types.test.ts`).

```tsx
export const threadsSource = liveDataSource(mailThreads, {
  searchable: ["subject", "snippet"],
});

const fields = [
  // a field mapped onto a column
  {
    id: "labels",
    column: mailThreads.column("labelIds"),
    values: (t) => t.labelIds,
    …
  },
  …
];

<DataView<MailThread>
  storageKey={…}
  fields={fields}
  views={["list"]}
  source={threadsSource.scoped({ where: { accountId } })}
  …
/>;
```

- **`scoped({ where })`** ANDs a base filter (filterable columns). While the scope
  value loads, mount over `source.awaitingScope([columns])` (one loading state,
  toolbar up). The Filter control never offers a scoped column (`resolveLiveFields`).
- **Facets** (`facets: ["kind", …]`): text columns whose options are READ
  (`CollectFacetOptions`, `web/internal/facet-options.tsx`) →
  `optionsResult: FieldOptionsResult`.
  - `FieldDef` takes `options` XOR `optionsResult`.
  - Value-sorted; a full grouping is the error arm (never truncated).
  - A facet field declaring `options`, or an unread facet, throws.
- **`FieldDef.column`** maps a field onto a column (minted only by
  `collection.column(name)` or a contributed handle's `.column(field)`).
  - Field ids stay the persisted vocabulary; no column ⇒ lowers under its id;
    derived ⇒ display-only.
  - Scoped refs (`scopedLiveColumns(...).column(member)`) resolve only on a
    collection whose `columnScope` matches.
- **A `columnScope` collection is listed on that one surface** (asserted equal to
  `storageKey`); passed to extensions as `FieldExtensionProps.liveColumnScope`.
- **Checked where declared** (`web/internal/live-fields.ts`): `sortable` over a
  non-sorting column, a domain mismatch, a foreign ref all throw (extensions inside
  their own `render`). A `column` on an in-memory DataView throws.
- **Lowering** (`web/internal/live-source.ts`, `useLiveSource`): Filter / Sort offer
  only filterable / sortable columns; filter → columns, ANDed with scope and search
  (debounced 200 ms), canonicalized. Empty sort → collection default.
- **Unresolved saved rule**: pending while the deferred tier loads, then the error arm.
- **Group-by** per `liveGroupLowering` (`web/internal/live-fields.ts`), the ONE answer
  for both the control (`offersGrouping` / `groupableField`) and the source:
  - **Server sections** — a `oneBucketPerValue` grouping over a groupable (own
    filterable text/number/boolean, or exposed) column:
    `SourceView kind: "sectioned"`.
    - One `useLive(c, { groupBy, … })` lists sections with exact live counts
      (`serverSections`, `web/internal/live-sections.tsx`; ordered by bucket
      ordinal, NULL/blank merged into "None").
    - Each section's rows are a `SectionRead` over `where ∧ eq(col, value)`, read
      only while **active** (expanded and its footer in view).
    - Readers are sibling components (no body remount).
    - Full at `LIST_MAX` → footer notice; a filter on a scoped column →
      `UngroupableFilterError`.
  - **Order prefix** — over a sort-only column: prepended to the order,
    `sectioning: { kind: "appearance" }`.
  - **Buckets** — other groupings over a sortable column: partitioned from loaded
    rows.
  - Over neither: **not offered**. Contract: a field's `value` IS its column's value.
- **Declared sections reach views as data**: `DataViewRenderProps.sectioning` =
  `{ kind: "bucket" | "appearance" }` | `{ kind: "declared", sections }`; hand it to
  `useDataViewSections` untouched. `DataViewSection.paging` carries the section's
  paging; `SectionBody` ends in its footer (`SectionPagingFooter`).
- **Section counts are a type** (`SectionCount`: `exact` | `atLeast`,
  `formatSectionCount`: `n` / `n+`).
- **States**:
  - skeleton while the head page (or a pending rule) loads;
  - empty once settled;
  - unavailable rule / over-bounds filter in place of the view;
  - a failed head as `SourceView.readError` (same `error` arm as `readiness`);
  - a paging-blocking failure in the footer (`LivePageError.blocksPaging`);
  - other page errors as one notice above the rows.

  Search-only changes keep previous rows; other query changes start over with
  `useHeldHeight`. Truncation → footer (`TRUNCATION_HINT`).
- **Column headers sort only what the source sorts** (`DataViewRenderProps.sortHeader`;
  the host's `setSort` throws otherwise).

### Typed fields are the generic extension point

To filter on a new dimension, **add a typed `FieldDef`** — never a bespoke toolbar
chip. Any type with a `FilterOperatorSet` (`bool`, `enum`, `number`, `date`, `tags`,
`text`) appears in Filter; `enum` reads `FieldDef.options`.

- The nested table honours filter (subtree-preserving) and sort (per sibling
  group, suspending DnD; empty sort = rank order).
- `supportsSort: false` on a `DataViewContribution` (a data-view flag, not
  view-core's) hides Sort for a view type with no sort axis.

Body rendering is **show-all by default** (`properties`, not `primary`). For a
**filter-only** field, set `visible: false` (or author a `properties` list), plus
`filterable: false` to keep it out of search — e.g.
`config/config_v2/settings/config_v2.settings.nav.jsonc`.

## Per-view visible fields (Properties)

Body fields and order are per view: `properties?: PropertyEntry[] | null` in the
`view` blob, entries `{ id, hidden?: true }`.

- **`null` / absent** → every field in schema order except `FieldDef.visible: false`;
  new fields auto-appear.
- **explicit list** → body order; `hidden` entries keep their place; a schema field
  the list doesn't name is **hidden, at the end of its band** (Notion parity). The
  first edit writes every field. Legacy `visibleFields: string[]` migrates via
  `visible-fields-to-properties` (`shared/view-migrations.ts`).

### `FieldDef.visible` — a field can be a dimension without being printed

`visible: false` = feeds sort/filter/group/search, not in the default body;
switchable in Properties.

**Both "show everything" branches must read it**:

- `web/internal/resolve-body-fields.ts` (unconfigured branch filters
  `f.visible !== false`);
- `web/internal/use-properties-controller.ts` (seeds visibility from it — else
  Properties shows it on while the body hides it).

It is a **default, not enforcement**: under an explicit list it reads hidden;
"Show all fields" resets to `null`.

`properties` governs **body rendering only** — filter/sort/search use the full
schema (views run `useDataViewSections` on full `fields`, then
`usePlacement(fields, properties, …)`), which hides what the list hides.

UI: **"Properties"** in View settings (`MdTune`) "Current view" — a `view`-scope
`Setting` (`PropertiesControl`):

- sortable rows with an eye toggle, "Show all fields";
- over a view that declares slots: one band per slot (Lead, Title, …,
  Hidden) — a field the user hid stays listed (faint) in the band it would be
  drawn in if shown (`propertyBands`), so the eye toggles in place; Hidden
  lists only what the view cannot draw — each row's "Show in…" page moving the field to a slot
  (`PropertyEntry.slot`, `moveToSlot`), and "Reset to the view's layout"
  (`resetSlots`);
- applicable with >1 field;
- writes `updateView(id, { properties }, { merge: true })`.

### The card's slots

`cardFieldsOf(placement)` (web barrel) reads a card's lines off the placement:
`lead`, `title`, `afterTitle`, `line2`, `trail` (the gallery declares at most
3), `edge`.

- **Cover**: `resolveCover(drawnFields(placement), DataViewProps.cover)` —
  accessor → `FieldDef.cover` → first `media` field — drawn by
  `<CoverFrame size="card" | "thumb">`; the cover field is in no line.
- `<CardMeta>` draws a line whenever the VIEW has fields for it (every card the
  same height); empty values are omitted.
- A coverless gallery card shows a `visual` lead, else a title **monogram**
  (`coverMonogram: hide` disables), else blank. A lead that is no visual is a
  glyph in the cover's corner.
- Sizes/inks are `ui/tokens/data-view` tokens (gallery CLAUDE.md).

## The rail (the inverted topology)

Every horizontal band the DataView owns (toolbar, bodies, group headers, table rows,
skeletons) applies `rail-follow`. **The DataView container itself never pads — its
bands do** (making `PaneChrome` a region owner would inset full-bleed panes).

- A host that insets a DataView **opens a region** (`rail-<step>`, pads and publishes,
  zeroing `--rail-owed-*`). Never `Inset` + a rail class on one box.
- A host wanting a **different** rail publishes `--rail-start` / `--rail-end` without
  padding (the app-shell sidebar).

See `research/2026-08-17-global-inset-ownership-rail-contract-v2.md`.

## Placement: always natural-height, never owns a scroll

`<DataView>` is always natural-height and **never owns a scroller** (root
`<Stack gap="none">`, no `min-h-0 flex-1`); the enclosing pane owns the one scroll
(`<PaneScroll>`, `@plugins/primitives/plugins/pane/web`). Exception: overlay
arrangements.

- **The toolbar is a `<Sticky edge="top" mask>`**; the root is its containing block,
  so stacked DataViews hand off. `mask` paints `bg-chrome-mask`.
- **`PaneChrome` provides the scroll**; a non-pane host supplies its own scroller.
- **Wide tables** mark `data-scrolls-x`; the pane's `Scroll` scrolls sideways too,
  moving only the table (`css/scroll`, `data-table` "Wide tables").

**Dev guards** (`use-dev-guards.ts`, `console.error`, never throw):

1. The nearest overflowing ancestor must scroll (forgot `<PaneScroll>`).
2. The root's `--chrome-mask` must equal the painted ancestor background — fix an
   ad-hoc `bg-muted`/`bg-card` wrapper by routing it through `<Surface>`.

## Row virtualization (`VirtualRows`)

`<VirtualRows>` lives in its own leaf primitive (`primitives/virtual-rows`) so
list, table and `primitives/tree` share it.

- **API**: `items`, `estimateSize`, `getKey`, `itemClassName?`, `overscan?`,
  `scrollToIndex?`, `children(item, index)`.
- It **self-discovers the scroll container** (`findScrollParent`) and measures
  `scrollMargin` — not a threaded ref, since the DataView never owns its scroll.
- Windowing is always **within** a group section (headers stay mounted).

| View | Threshold | Notes |
|---|---|---|
| **list** | 100 entries | Composes with drag via `keepMounted` + `raisedKey`. |
| **gallery** | 60 cards | Lane-aware: a windowed row is one line of `columns` cards. |
| **icons** | 120 tiles | Lane-aware; lanes from the probe grid's track count. |
| **table** | 100 rows (grouped: per section) | Grid-flow spacers, not absolute positioning (subgrid tracks stay aligned). Nested: windows visible lines, keeps drag source and selected row mounted, `scrollToIndex` for reveal. |

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Notion-like multi-view data surface: one typed field schema rendered through swappable views with per-view sort/search/filter.
- Web:
  - Slots:
    - `DataViewSlots.View`
    - `DataViewSlots.FieldExtension`
    - `DataViewSlots.RowOrder`
    - `DataViewSlots.Setting`
    - `DataViewSlots.Control`
    - `DataViewSlots.CollectionItemAction`
    - `DataViewSlots.CollectionRowActivation`
    - `DataViewSlots.Cell`
    - `DataViewSlots.CellEditor`
    - `DataViewSlots.Filter`
    - `DataViewSlots.ValueCodec`
    - `DataViewSlots.Grouping`
    - `DataViewSlots.ColumnConfig`
  - Slot contributors: 61 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `DataViewSlots.Cell` ×16
    - `DataViewSlots.Filter` ×9
    - `DataViewSlots.CollectionItemAction` ×8
    - `DataViewSlots.CellEditor` ×6
    - `DataViewSlots.View` ×5
    - `DataViewSlots.CollectionRowActivation` ×4
    - `DataViewSlots.Grouping` ×4
    - `DataViewSlots.ValueCodec` ×3
    - `DataViewSlots.Setting` ×2
    - `DataViewSlots.ColumnConfig` ← `fields.enum.column-config`
    - `DataViewSlots.Control` ← `primitives.data-view`
    - `DataViewSlots.FieldExtension` ← `primitives.data-view.custom-columns`
    - `DataViewSlots.RowOrder` ← `primitives.data-view.view-order`
  - Contributes: 103 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.WebRegister` ×93
    - `DataViewSlots.Control` ×4
    - `DataViewSlots.Setting` ×4
    - `IdKinds.Kind` ×2
  - Uses: 131 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `network/live` ×20
    - `primitives/css/ui-kit` ×17
    - `primitives/data-view/view-core` ×11
    - `primitives/live-state` ×6
    - `primitives/slot-render` ×5
    - `primitives/css/control-panel` ×4
    - `primitives/collapsible` ×3
    - `primitives/css/text` ×3
    - `primitives/css/toggle-chip` ×3
    - `primitives/tree` ×3
    - `config_v2` ×2
    - `primitives/css/fill` ×2
    - `primitives/css/overlay` ×2
    - `primitives/css/row` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/sticky/stack` ×2
    - `primitives/css/sticky` ×2
    - `primitives/cursor-pagination` ×2
    - `primitives/dom/element-size` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/latest-ref` ×2
    - `primitives/loading` ×2
    - `primitives/row-actions` ×2
    - `primitives/search` ×2
    - `primitives/shortcuts` ×2
    - `primitives/sortable-list` ×2
    - `shell/toast` ×2
    - `fields.Fields`
    - `ids.IdKinds`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/coords.Placed`
    - `primitives/css/inline.Inline`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/surface.Surface`
    - `primitives/css/yield.yieldClass`
    - `primitives/dom/auto-scroll.KeepAnchorAcross`
    - `primitives/dom/in-view.createInViewWatcher`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/icon-button.IconButton`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/pane.usePaneViewParam`
    - `ui/icons.Icon`
  - Exports (types):
    - `CardFields`
    - `CardMetaProps`
    - `CellContributionMeta`
    - `CellEditorProps`
    - `CollectionItemActionContribution`
    - `CollectionItemActionOwner`
    - `CollectionRowActivationContribution`
    - `ColumnConfigDerive`
    - `ColumnConfigProps`
    - `CoverContent`
    - `CoverFrameProps`
    - `CreateOption`
    - `DataViewAggregateConfig`
    - `DataViewAttachConfig`
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
    - `DataViewSwitcherProps`
    - `DataViewViewEdits`
    - `DataViewViewportSink`
    - `DropTargetProps`
    - `FieldCellProps`
    - `FieldDef`
    - `FieldExtensionContribution`
    - `FieldExtensionProps`
    - `FieldGrouping`
    - `FieldGroupingSet`
    - `FieldOption`
    - `FieldOverride`
    - `FieldOverrides`
    - `FieldPresentation`
    - `FieldPresentationProviderProps`
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
    - `HierarchyTree`
    - `HierarchyTreeOptions`
    - `ItemActionArms`
    - `ItemActionEntry`
    - `ItemActionFilter`
    - `ItemActionPlacement`
    - `ItemActionProps`
    - `ItemActionRender`
    - `ItemActions`
    - `ItemActionsDescriptor`
    - `ItemActionTarget`
    - `ItemActionZones`
    - `LeadingSlotProps`
    - `LivePagesPaging`
    - `LoweredFilter`
    - `ManualOrderConfig`
    - `PartitionOptions`
    - `PlacedSlots`
    - `Placement`
    - `ProjectedRow`
    - `ResolvedCover`
    - `RowDnd`
    - `RowDndHierarchy`
    - `RowDndProps`
    - `RowDndSequence`
    - `RowDragConfig`
    - `RowDropConfig`
    - `RowDropContext`
    - `RowDropEdge`
    - `RowDropPlace`
    - `RowFilter`
    - `RowSelectionConfig`
    - `RowTone`
    - `SectionBodyProps`
    - `SelectionConfig`
    - `SortController`
    - `SortPreset`
    - `SortRule`
    - `TableCellProps`
    - `UnavailableRule`
    - `ValueCodec`
    - `ViewRowDropConfig`
    - `ViewState`
  - Exports (values):
    - `applyFilter`
    - `attachedChildrenOpen`
    - `attachExpandKey`
    - `cardFieldsOf`
    - `CardMeta`
    - `CardTokens`
    - `ChipSelectFilterInput`
    - `coverDetailClass`
    - `CoverFrame`
    - `coverHeldAttr`
    - `coverHoverGroup`
    - `CreateButton`
    - `DATA_VIEW_HEADER_OFFSET_VAR`
    - `DataView`
    - `DataViewGroupHeader`
    - `DataViewSlots`
    - `DataViewSwitcher`
    - `DataViewViewChip`
    - `DataViewViewList`
    - `defineDataView`
    - `defineDataViewSources`
    - `defineItemActions`
    - `drawnFields`
    - `drawnSubtitleTerms`
    - `DROP_TARGET_RING`
    - `DROP_TARGET_WASH`
    - `DropBackground`
    - `DropInsertLine`
    - `dropOrderOf`
    - `EditableCell`
    - `EditableTreeLabel`
    - `fieldAlign`
    - `FieldCell`
    - `fieldOverrides`
    - `FieldPresentationProvider`
    - `FilterValueInput`
    - `getDataViewDescriptor`
    - `GroupedSections`
    - `IDENTITY_CODEC`
    - `IDENTITY_GROUPING`
    - `IDENTITY_GROUPING_SET`
    - `isElidedRead`
    - `isFilterGroup`
    - `isGroupableField`
    - `leadingSlot`
    - `liveDataSource`
    - `makeSortComparator`
    - `MissingDataCellError`
    - `NestedSectionIndent`
    - `partitionIntoSections`
    - `pickCoverField`
    - `pickPrimaryField`
    - `PillsToolbar`
    - `PrimaryActionSlot`
    - `PrimaryOverThumbnail`
    - `QuietOption`
    - `readFallback`
    - `resolveBodyFields`
    - `resolveCover`
    - `rowToneClass`
    - `SectionBody`
    - `SubtitleRun`
    - `UNGROUPED_FOLD_KEY`
    - `useDataViewControls`
    - `useDataViewSections`
    - `useFieldIdentities`
    - `useFieldPresentation`
    - `useFilterClock`
    - `useFilterController`
    - `useFlatRows`
    - `useGridPhase`
    - `useGroupByController`
    - `useGroupingClock`
    - `useGroupingRegistry`
    - `useHierarchyTree`
    - `useIsBackgroundDropTarget`
    - `useIsChipField`
    - `useItemActionZones`
    - `useLivePagedValuePaging`
    - `useLivePagesPaging`
    - `usePlacement`
    - `useResolveCell`
    - `useResolveCellEditor`
    - `useResolveColumnConfig`
    - `useResolveColumnDerive`
    - `useResolveFieldKind`
    - `useResolveGroupings`
    - `useResolveOperatorSet`
    - `useResolveValueCodec`
    - `useRowDnd`
    - `useRowDropState`
    - `useRowFilter`
    - `useSortController`
    - `useViewRowCounts`
    - `wearsTimeInk`
- Server:
  - Contributes: 95 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `ConfigV2.Register` ×93
    - `ids.kind` ×2
  - Uses:
    - `config_v2.getConfig`
    - `config_v2.watchConfig`
    - `ids.IdKinds`
    - `primitives/data-view/view-core.buildViewConfigRegistrations`
    - `primitives/data-view/view-core.viewsDescriptor`
    - `ui/icons/saved-sources.defineSavedIconSource`
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
    - `CoverContent`
    - `CreateOption`
    - `DataViewActiveChrome`
    - `DataViewAggregateConfig`
    - `DataViewAttachConfig`
    - `DataViewBaseProps`
    - `DataViewDataOrigin`
    - `DataViewDeclaredSection`
    - `DataViewDensity`
    - `DataViewFoldLines`
    - `DataViewId`
    - `DataViewInMemoryOrigin`
    - `DataViewLiveOrigin`
    - `DataViewPageNotice`
    - `DataViewPagePlaceholder`
    - `DataViewPagePlaceholders`
    - `DataViewPaging`
    - `DataViewPagingTotal`
    - `DataViewPart`
    - `DataViewProps`
    - `DataViewRenderProps`
    - `DataViewReserve`
    - `DataViewRowEntry`
    - `DataViewRowsCollection`
    - `DataViewRowsComplete`
    - `DataViewSearch`
    - `DataViewSearchSuggestions`
    - `DataViewSection`
    - `DataViewSectionIdentity`
    - `DataViewSectioning`
    - `DataViewSectionPaging`
    - `DataViewSurfaceChrome`
    - `DataViewToolbarSpec`
    - `DataViewViewEdits`
    - `DataViewViewportSink`
    - `DataViewVisibleRows`
    - `FieldDef`
    - `FieldExtensionProps`
    - `FieldExtensionsDescriptor`
    - `FieldGrouping`
    - `FieldGroupingSet`
    - `FieldOption`
    - `FieldOptionsResult`
    - `FieldOverride`
    - `FieldOverrides`
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
    - `FoldLimit`
    - `FoldRule`
    - `GroupBucket`
    - `GroupBucketAncestor`
    - `GroupByRule`
    - `GroupingPlanContext`
    - `HierarchyConfig`
    - `HostedToolbar`
    - `HostedToolbarForms`
    - `HostedToolbarParts`
    - `ItemActionEntry`
    - `ItemActionFilter`
    - `ItemActionPlacement`
    - `ItemActionProps`
    - `ItemActionsDescriptor`
    - `ItemActionTarget`
    - `ItemActionZone`
    - `LiveDataSource`
    - `LiveDataSourceOf`
    - `LiveFacetColumn`
    - `LiveSearchableColumn`
    - `LiveSourceScope`
    - `ManualOrderConfig`
    - `Nesting`
    - `PlacementMatch`
    - `PlacementSpec`
    - `PresetId`
    - `PropertyEntry`
    - `Recipe`
    - `RecipeRule`
    - `RowDragConfig`
    - `RowDropConfig`
    - `RowDropContext`
    - `RowDropEdge`
    - `RowDropPlace`
    - `RowSelectionConfig`
    - `RowTone`
    - `SectionCount`
    - `SectionsToolbar`
    - `SectionsToolbarForms`
    - `SelectionConfig`
    - `Slot`
    - `SlotForm`
    - `SlotSpec`
    - `SortPreset`
    - `SortRule`
    - `SubItemsKind`
    - `TableCellProps`
    - `ToolbarArrangement`
    - `ToolbarPartForms`
    - `ToolbarParts`
    - `ValueCodec`
    - `ViewExpandAll`
    - `ViewRowDropConfig`
    - `ViewSlots`
    - `ViewState`
  - Exports (values):
    - `atLeastCount`
    - `compareValues`
    - `DATA_VIEW_HEADER_OFFSET_VAR`
    - `DATA_VIEW_PARTS`
    - `dataPart`
    - `defineDataView`
    - `exactCount`
    - `fieldOverrides`
    - `FilterGroupSchema`
    - `filterNodeIdKind`
    - `FilterNodeSchema`
    - `FilterRuleSchema`
    - `formatSectionCount`
    - `IDENTITY_CODEC`
    - `isFoldLimit`
    - `isHostedToolbar`
    - `isSectionsToolbar`
    - `optionDescendants`
    - `orderFieldsBySection`
    - `PARENT_FIELD_ID`
    - `presetIdKind`
    - `RECIPES`
    - `scopeFilterRows`
    - `SHARED_FIELD_SECTION`
    - `SLOT_RANK`
    - `SLOTS`
    - `splitFieldSections`
    - `sumSectionCounts`
    - `UNGROUPED_FOLD_KEY`
    - `visibleSections`
- Cross-plugin:
  - Uses tokens: 92 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/data-view` ×46
    - `ui/tokens/density` ×16
    - `ui/tokens/color-palette` ×15
    - `ui/tokens/type-scale` ×9
    - `ui/tokens/shadow` ×3
    - `ui/tokens/shape` ×3
  - Imported by: 122 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `fields` ×39
    - `apps` ×28
    - `debug` ×15
    - `primitives` ×10
    - `conversations` ×8
    - `infra` ×4
    - `tasks` ×4
    - `plugin-meta` ×2
    - `apps-core/app-launcher`
    - `auth`
    - `build/build-logs`
    - `config_v2/settings`
    - `history/dialog`
    - `integrations/google-maps/usage`
    - `menu-bar/app-grid`
    - `page/links`
    - `runs`
    - `shell/notifications`
    - `stats/cost`
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
    - `deriveFields` — {@link useDerivedFields}, pure.
    - `describePagedConformance` — The paged-view contract every DataView view honours, run against `view` mounted through the real body on a laid-out page (`mountPagedDataView`):
    - `isFieldValueEmpty` — Whether `field` has nothing to show for `row` — THE empty test, shared by the table's edit affordance (an empty editable cell offers its pencil over an "Empty" placeholder) and the card / list meta (an empty field is simply omitted, never drawn as "Empty").
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
  - **`custom-columns`** — User-defined custom columns for any DataView: the config-backed definition controller, the per-row values live hook + upsert mutation, and the toolbar settings (Fields) button. Custom-column…
  - **`floating-toolbar`** — Floating toolbar arrangement for the data-view primitive: the band floats over the view (a full-bleed map under it) — the view tabs as a floating card top-left, past the surface's aside, and search…
  - **`gallery`** — Gallery view child for the data-view primitive: a responsive grid of cover cards — the cover is the card, its fields three fixed lines under it, its actions on the cover.
  - **`icons`** — Icons view child for the data-view primitive: a centred launcher grid of fixed-size tiles (the row's leading avatar filling a squircle) with the name underneath, drag-to-reorder in manual order.
  - **`list`** — List view child for the data-view primitive: a compact single-row-per-item list (Row primitive) with field-driven label/subtitle/trailing, active-row highlight, and hover item actions.
  - **`map`** — Map view child for the data-view primitive: every row with a location as a pin on a full-bleed map, clustered, with clicking a pin activating its row.
  - **`table`** — Table view for data-view: maps the typed field schema to data-table columns with host-controlled sort, and nests its rows (a tree is a table with no columns) when the source has a hierarchy.
  - **`view-core`** — Type-agnostic named-view-instance engine: instance model + resolver, config-descriptor machinery, debounced write-back, and the editable view-switcher chrome. Type-agnostic named-view-instance…
  - **`view-order`** — Per-view-instance manual row order for any DataView: subscribes to the persisted (dataViewId, viewId) ranks, synthesizes a total order, and contributes the resulting ManualOrderConfig back through…

<!-- AUTOGENERATED:END -->
