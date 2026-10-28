# data-view — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

## Architecture

- **One global `View` slot, not a per-host factory.** It follows the
  `segmented-progress-bar` precedent (one global `Variant` slot, children
  contribute variants).
- Rejected: the `defineTabbedView` factory shape. That factory exists because
  each tab host has a *different* set of tabs. Data views are a fixed shared
  vocabulary with one render-props contract, so one global slot is enough.
- **Raw rows to every view.** Each view applies the processing that matches its
  own semantics: flat views use `useFlatRows`, and the nested table filters
  subtree-preserving. The one shared filter predicate is what keeps
  filter/search/sort identical across views.

## Config mode is universal (no default mode)

- **Why a branded id.** `defineDataView` brands the string so that a consumer
  cannot pass a raw one. That makes every surface id discoverable by codegen,
  the same way `reorder` discovers its slots. The `:` ban keeps the id usable as
  a config file name.
- **Why a reference-stable descriptor per id.** `useViewsConfig` resolves it by
  reference identity against the registration (like
  `reorderDescriptors.get(slotId)`). A descriptor rebuilt per call would not be
  found.

### The rows' own read: `readiness`, never `emptyState` for a failure

- Rejected: a boolean `loading` prop. A boolean cannot say that a read failed.
  Left `true`, a failed read renders as a skeleton forever. Set to `false`, it
  renders as "no rows", which is a false claim about the user's data.
- **Why `readiness` takes the whole result.** With the read's `status`, the body
  can order its states, so `emptyState` can only ever mean "ready, and zero
  rows".

### Config is the single source of truth (fail by default)

- **Why no code-synthesized default view.** A code fallback lets a surface ship
  without anyone composing its views. `requiresAuthoredOverride` plus
  `config:overrides-authored` is the forcing function that makes an agent
  author them.
- **Why the check tests review, not presence.** A seeded `{"views": []}` file
  exists but renders "No views configured" at runtime.
- **Why the placeholder waits for a known config.** A surface whose config has
  not arrived also has zero instances. Showing "unconfigured" during that window
  is a wrong answer that the user then watches get rewritten.

### The view config row

- **Why the origin default has a stable hash.** `{ "views": [] }` does not depend
  on which view types are registered, so adding a view type never invalidates
  committed configs.
- **Why legacy shapes migrate on read only.** Old shapes (a single-object sort,
  a bare-string `groupBy`) are still on disk in committed configs. Rewriting on
  read would churn every file. A file is rewritten only when the user next
  edits that key.
- **Pinned sort is for** an ordering the surface always wants first but the user
  may turn off (Finder's "Keep folders on top").
- **Why pins are a prefix enforced at both config boundaries.** Code that
  *applies* a sort (the comparator, the nested table's global sort, the live
  `orderBy` lowering) iterates the list unchanged, so it cannot forget a pin.
  Only the editing paths need to know that pins exist.

### Adoption is enforced (`no-adhoc-row-list`)

The two checks work as a pair:

- `no-adhoc-row-list` fires when code avoids DataView.
- `config:overrides-authored` fires until the adoption is finished (the views
  are authored).

Background:
[2026-07-17-global-data-view-adoption-guardrail](../../../../research/2026-07-17-global-data-view-adoption-guardrail.md).

### The model, and where each piece of state lives

- **Why runtime edits go to the user-global layer.** An `app:` scopeId writes a
  scope key that the read path ignores until the scope is forked, so the edit
  silently disappears on reload. The per-id descriptor already scopes views to
  one surface. Per-app forking is a Settings-pane concern.
- **Why the search query is per tab.** Durable narrowings (`sort` / `filter` /
  `groupBy`) live in the config row and render as visible chips. A query is an
  ad-hoc gesture. If it survived a browser restart, it would leave a filtered
  subset that reads as the view's whole contents.
  - `sessionStorage` keeps the one property worth persisting: F5 does not lose
    your place.
  - A query that *should* survive belongs in the URL, where it is shareable and
    the back button clears it.
- **Why collapse state is never a domain column** (an `expanded` field on the
  row's own table). The repo has hit all three of these failure modes:
  - **One flag cannot serve two views.** Two instances over the same rows, a
    scoped sub-tree, or the same tree on two devices fight over one value.
    Collapsing in one place silently collapses the others.
  - **It writes the domain.** A UI gesture becomes a DB write, a change-feed
    recompute and a live push to every client. It also bumps `updatedAt`, a
    visible, sortable field.
  - **It does not bound.** Expand-all is `O(nodes-with-children)` and, unlike
    `view-order`'s ranks, has no invariant to exploit for a bounded write.
- **Why there is no consumer accessor for expansion.** The map is the only
  source, so a collapse cannot become domain data. Background:
  [2026-07-28-global-tree-collapse-state-as-view-state](../../../../research/2026-07-28-global-tree-collapse-state-as-view-state.md),
  [2026-07-29-global-delete-hierarchy-expand-hooks](../../../../research/2026-07-29-global-delete-hierarchy-expand-hooks.md).
- **Why the orphan skip is fail-soft.** It is the same hazard class as reorder
  node-type ids: the row stays in config and renders again once its view type
  returns. The skip is safe **only** while nothing the user can click puts a
  row into it.
  - That is why the options sub-form's type picker is gated exactly like the
    `+` menu.
  - An ungated picker could switch a view to a type the surface could never
    have created, and the view would silently vanish.
- **Why a missing companion throws instead of skipping.** A type the repo
  provides but the bundle lacks is a composition bug, not an orphan. A quiet
  fallback would hide it.

## Addressable views: the active view is in the URL

- **Why the URL is derived, not written on select:**
  - A list on its default view adds nothing to the address.
  - A view restored from this device is stamped in, so the URL is shareable.
  - A stale id is rewritten to the view actually shown.
- **Why a URL-opened view is also adopted locally.** Otherwise the screen jumps
  when the address later stops naming it.
- **Why every write replaces.** One history entry per view switch would make
  Back walk through chip clicks.

## Meta-DataView: one list over sources of different entities

- **Why shared fields share one id.** A filter, a sort, a group-by or a saved
  view then means the same thing on every row, and runs in SQL over every
  source at once.
- **Why the source field's options are derived from the registered arms.** The
  list then offers every installed source, not only the sources present on the
  loaded page. That is also why a union that declares its own options for the
  source field throws.

## Multi-source surfaces (`DataViewSwitcher`)

- **Why `views` is static contribution metadata.** The view model must resolve
  *every* config row (switcher chips, add-menu gating) before any source mounts,
  and only the ACTIVE source ever mounts.
- **Why switching sources remounts the body.** Per-source subscriptions and
  controllers restart cleanly instead of carrying state across sources.
- **Why a source must always call `render`.** An early `return null` makes the
  surface chrome vanish while the source loads.
- **Why instance ids must be unique across sources.** `normalizeRows` would
  disambiguate a duplicate with an index suffix. That silently renames the row
  and orphans its durable `data_view_row_order` rows.
- **Why presets are not namespaced per source.** Sharing them per surface is
  fail-soft by design: a preset naming a field the active source lacks is
  dropped by the controllers' dangling-fieldId guards.

## Hierarchy

- **Why the host decides nesting once and passes `hierarchy` only while
  nesting.** A table drawn flat is then simply the flat table: fold and flat
  manual order come back, and no flat-mode code needs a "but nested" branch.
- **Why `hierarchy` excludes `paging` and live sources.** A tree over a paged
  prefix orphans the children whose parents are not loaded.
- **Why there is no `isExpanded` / `onToggleExpanded` pair.** The pair made the
  domain-column anti-pattern (see "The model…") representable. It also admitted
  a half-wired state:
  - The two accessors were independently optional.
  - Supplying only one gave a chevron whose write went to the view map and whose
    read came off the row.
  - The result was a silently dead toggle that no check could catch.
- **Why `expandOnActivate` is safe.** "Click a folder to open it" is a stateless
  predicate on the table options, so it cannot be half-wired.
- **Why expand-all is reported up by the view.** Only the view knows which rows
  it draws. The toolbar never asks which view type is active.
- **Why the tree geometry is density tokens.** The indent is the chevron box
  plus the row gap, so a child's chevron sits under its parent's icon. The guide
  is half the chevron box, so a level's guide runs under its parent's chevron.
  A theme that sets its own `treeIndent` owns its own rhythm.

### Leading field

- **Why composition, not replacement.** Most views' own leading option is a
  status glyph, not an identity, and a surface can want both (avatar, then
  status dot). One shared `leadingSlot` renders the pair so the order cannot
  drift between views. It returns `undefined` when empty, so a host slot still
  sees "no icon".
- **Why there is no type-based fallback.** data-view names no field type, so
  only the flag can qualify a field.

## Manual order

### Manual order is the default; a sort overrides it

- **Why the Sort control stays visible in manual mode.** It must stay
  reachable so the user can clear the sort.
- **Why the popover says when a sort shadows an order.** A sort is the only
  thing that suspends drag, so the cause must never be silent.
- **Why cross-section drops are a separate capability.** A drop into another
  section needs the group-by field written, which only the consumer can do.
- **Why the refusal is collision-based.** Without `onReseat`, collision
  detection sees only the row's own section, so the refusal is *visible* during
  the drag. Rejected: a drop-time no-op, which looks like the drop worked.
- **Why the pending-move overlay exists.** dnd-kit clears the slide transforms
  the moment the row is released. Without the overlay the row snaps back to its
  old place until the new order lands.
- **Why windowing and drag compose.** Three mechanisms keep an in-flight drag
  alive when its source row scrolls out:
  - `measuringAlways` re-measures droppables every frame;
  - `keepMounted` pins the drag source;
  - `raisedKey` lifts the dragged row's windowed wrapper (its own stacking
    context) over the rows it crosses.
- **Why the table uses spacers.** Windowed table rows use spacers, not
  transforms, so the row's own slide transform leaves the subgrid tracks alone.

### The global `RowOrder` slot (cross-plugin)

- **Why `defineRenderSlot`.** Contributor precedence is then a committed reorder
  override, not an accident of import order.
- **Why the reader sits beside the surface.** A fold that *wraps* the surface
  makes its contributors ancestors of the band, aside and view. Switching
  list ↔ gallery then remounted all of them, and a backdrop map lost its camera.
- **Why `rows` is filter-applied and search-excluded.**
  - Rows the view filters out never receive a rank.
  - Search changes only what is *rendered*, so a drag under an active search
    still resolves against the full ordered set.

### The `rowOrderEnabled` gate

Each clause is a structural exclusion, not a preference:

- gallery / icons, and a table nesting a hierarchy, have no flat rank axis;
- a live source is server-sorted, so the client cannot own the order;
- an aggregate representative's rank cannot stand for its members.

Group-by as a clause:

- **Failure mode.** As a gate clause it silently disables drag on any surface
  with a default `groupBy` (the Pages sidebar).
- **Why it is not needed.** Within-section reordering is well defined: the order
  covers the whole unpartitioned set, so a drop anchored on a same-section
  neighbour resolves globally. The one unsupported case, a drop into another
  section, is refused per drop.

Why the sort test is not a clause: as a clause, toggling a sort off and on
would tear down the contributor's live subscription. The host only withholds the
config while a sort is set.

## Grouping is a field-type contribution

Rejected: the primitive naming types (`type === "enum" || type === "bool"`).

- That check had to be repeated in three places: groupability, section labels
  (enum options, `bool → Yes/No`) and the "enum follows `options` order" rule.
- A date field could not group at all: `String(aDate)` puts every row in its own
  section.
- Supporting it would have meant a fourth branch.

With types contributing their own groupings, the partition is pure mechanism.

### The contract (`core/internal/grouping.ts`)

- **Why `plan` is two-phase.** A grouping that must see the whole set before it
  can order its sections (enum by `options` index, the identity grouping by
  value order, a range-derived "Auto") does that work once per render, not once
  per row.
- **Why `now` is injected.** Calling `Date.now()` inside a grouping is wrong
  twice over:
  - it is untestable (precedent: `relativeDayLabel(date, now)`);
  - the partition runs inside a `useMemo`, so a live clock changes the memo key
    on every render.
- **Why the midnight timer is not banned polling.** It fires once, at the
  instant the value changes, which the calendar knows in advance, so a view left
  open overnight stops saying "Today". It never wakes up just to check.
- **Why one ascending ordinal.** Reading it from whichever end the sort points
  gives `startsAt asc` → Today, Tomorrow, Later and `startsAt desc` → newest
  month first, with no second config axis.
- **Why `groupOrder` comes from `activeState.sort`.** A live source zeroes
  `state.sort`, so reading `state.sort` would lose the direction.

### There is exactly one "None", and a grouping cannot mint a second

Failure mode: a date grouping that returns its own catch-all
(`{ key: "none", order: Number.POSITIVE_INFINITY }`) breaks twice:

- a second section, also labelled "None", appears beside the real one;
- `Infinity - n` is `Infinity`, so the catch-all pins last ascending but
  **first descending**. It jumps to the top the moment the sort flips.

`null` has neither failure mode. Infinity is only ever reached for to mean
"put this at the end", which it does not do; that is what `null` is for. So a
non-finite `order` throws.

### Groupability is derived, not listed

- **Why `hasGrouping` is published on the controls context.** A `Setting`'s
  `isApplicable` is a pure function and cannot read a slot.
- **Why the legacy string maps to the identity grouping.**
  `{ groupingId: "value" }` is exactly what a bare `"<fieldId>"` always meant,
  so the migration is lossless and needs no committed `.jsonc` edits.

### The picker

Rejected: a `usePanelStack` push for granularity (the `add-sort-affordance.tsx`
precedent). The choice is small and closed, and seeing the granularity next to
the field is the point, so it uses two bands.

## Grouped sections: one pipeline, one chrome

- **Why the chrome is shared, not per view.** Per-view JSX drifts: a view child
  silently forgets to pin its headers. A lint rule cannot state "a grouped
  section must be wrapped in sticky chrome". One shared branch makes the
  divergence unrepresentable. Background:
  [2026-07-17-data-view-gallery-sticky-group-headers](../../../../research/2026-07-17-data-view-gallery-sticky-group-headers.md).
- **Why the table is the exception.** Its group headers are `col-span-full`
  rows of `data-table`'s subgrid. Chrome that owned a `<Stack>` would move them
  out of the grid and break column alignment. The table still draws the same
  `DataViewGroupHeader` node, so its header cannot drift from the flat views'.

### `headerActions` — one affordance, scoped to one section

- **Why the count and the action sit apart.** They want opposite treatments: the
  count reads at rest, the action reveals on hover.
- **Why not `hover-reveal`.** That primitive defers row-action clusters to
  `row-actions`, and the two compete when combined.

## Aggregating sections (`aggregate`)

**Why "acting on the representative acts on the group" is left to the
consumer.** The representative is a real `TRow`, so activation, item actions and
`onMove` already fire on it. Mapping that to a group mutation (reseating every
member) is domain logic. The primitive owns only the visual collapse, the choice
of representative and the count badge.

## Fold: "… N more" per section (`ViewState.fold`)

- **Why a fold rather than a filter.** A filter removes rows. A fold keeps them
  counted and one click away. `keep` reuses the filter language so operators,
  editor, summary and persistence are shared, not duplicated.
- **Why search suspends folding.** A match must never hide behind "…".
- **Why paging uses a gate, not an unmounted sentinel.** Unmounting the
  sentinel behind the observer's back means it is never re-observed, and
  paging stalls silently.
- **Why there is no exported `FoldLine`.** A view cannot forget the line or put
  it on a different edge than its entries. `SectionBody` is the one band that
  pays the rail, so the line's content must not `rail-follow` again.
- **Why the fold editor uses `useFilterPanelStack()`.** A pushed page replaces
  the root's subtree. Without re-entering the scope, a nested group opened from
  the fold editor edits the view's filter instead of `fold.keep`.
- **Naming.** "Fold line" is unrelated to the nested table's fold-children
  header action, which collapses subtrees.

## Paging (`paging`)

- **Why read and paging come as one value.** The footer (loading more, Retry,
  the stop line), the notices, the hold and the viewport are then one code path.
  `useLivePagesPaging` also mints the viewport, so a read cannot page by a
  viewport that nothing measures.
- **Limit: a key-range-paged `liveValue` cannot be a source.** It reads through
  the same `useLive` pages, but a DataView source needs the filterable and
  text-column seams that a value does not have.
- **`narrowBy`.** It exists because rows filtered in memory over a paged read
  stop at the first page when the filter hides the read's tail: the next page
  waits for the tail to be on screen.
  - **Why widening.** A rule no column backs (a list's synthetic field) is
    dropped, not refused, because the rows are still filtered in memory.
  - **Why the total is keyed by filter identity.** An edited filter is a new
    tree, and its count is a new read.
  - **Why search is not lowered.** In memory, search matches any searchable
    field's text, which no column expresses.
  - **Why a contributed column reads no count.** A COUNT, like a `GROUP BY`,
    reads only own and exposed columns.
- **Viewport settle timing:**
  - `SETTLE_MS` (250 ms) keeps a fling from subscribing every page it crosses;
  - `MAX_WAIT_MS` (1 s) keeps a list whose rows never hold still (a busy feed)
    updating anyway.
- **Why measurements are keyed by an epoch.** Without it, a head that lands
  after the skeleton was measured, or a new query's head, is reported off
  screen by the rows it replaced, and is released the moment it lands.
- **Why the missing-marker failure is safe.** A view that forgets
  `data-row-key` releases nothing, so its pages stay live (never stale). It
  never breaks; it just never frees memory.
- **Why placeholders take exactly the room their rows took.** Releasing a page
  then changes no layout at all, which is the invariant: nothing has to be
  anchored. Anchoring is only the residue (rows that changed while away;
  `isPaged`, where nothing stands in).
- **Failure mode behind `overflow-anchor: none`.** Measured on the virtualized
  table: browser scroll anchoring locked onto a box the window was recycling and
  scrolled by a released page's height (+3100 px per release, with no script
  write). Whole pages of rows went past unseen.
- **Why grid views keep their phase.** A page released mid-line restarts the
  next card in column 0 and reflows everything below it.
- **Why the tail must be on screen to page.** Otherwise a sentinel still in view
  pages the whole read in behind a collapsed header.
- **Why no count under search.** It would be a count read per keystroke.

## Toolbar arrangements

### The default: a flat strip (`PillsToolbar`)

- **Why an overlay pill keeps its glass.** Over a canvas (a map) there is no
  band for a flat strip to sit on, so the pill is all the controls stand on.
- **Why one `ControlSizeProvider`.** Chips, icon triggers, the search field and
  the create button share `control-sm`, so they are centred on one line at every
  width.
- **Why the add-view `+` fades instead of unmounting.** It keeps its place, so
  the strip does not shift, and it stays tabbable.
- **Why `forms` is data.** The host builds each part once in the requested form.
  An arrangement only places nodes, so no arrangement can re-instantiate a part
  with diverging behaviour.
- **Why the host keeps the compact fold.** An arrangement chooses only the wide
  layout, so no arrangement can break a narrow pane.
- **Why the fade is a separate `raised` tail.** The band is `nav`. Its own
  `mask="fade"` tail would paint over the group headers pinned just under it
  and wash out their labels. A separate tail that comes before the view in the
  DOM is covered by a pinned group header (also `raised`, later in the DOM)
  while rows still pass under it.
- **Why `spaceBelow` is the tail's runway.** An unscrolled list's first row then
  starts where the tail has faded out.
- **Why `spaceBelow` is a sibling after the band.** It scrolls away with the
  content instead of growing the pinned band.

### Floating chrome: `overlay` arrangements and the `aside`

- **Why the backdrop sits at one tree position.** A view switch never remounts
  it, so a map keeps its camera.
- **Why the aside's free span is click-through.** A panel folded to its header
  leaves the view below it reachable.
- **Why the rules live in one assert** (`assertSurfaceChrome`). The surface
  either renders fully valid or throws before anything renders. No combination
  of props half-works.

### View edits: drafts, the home view, and the switcher's form

- **Why drafts.** A surface whose views are saved filters (presets) rather than
  places wants an edit to stay an edit until the user keeps it.
- **Why filter-node ids are ignored in the dirty check.** A filter rebuilt to
  what it was carries fresh ids. Comparing ids would leave it "dirty" forever.
- **Why `viewShortcuts` yields to text fields.** On macOS, ⌥digit types a
  character there.

### Row hover: `hoveredRowId` / `onRowHoverChange`

Failure mode for a bare "nothing hovered" report: two surfaces report one
pointer move (leaving a pin, entering a row) in an order nobody controls.

- React fires the row's `onPointerEnter` from the same `pointerout` the map's
  leave comes from.
- A lifted pin is a portal whose own container React listens on first.

A "none" from the surface being left erases the hover the other surface just
claimed. A release of its own id cannot.

## Hosted toolbar: no band

- **Use it for** a small, fixed list inside someone else's chrome (a card of
  live agents above a prompt box). There, search, filter and sort in a band of
  their own would be a strip that mostly does nothing.
- **Why `options` is hover-revealed off the root.** There is no band to anchor
  on.
- **Why loading and no-views come through the same frame.** The card never
  reflows as config settles.
- **Why it is not an arrangement.** An arrangement lays out a band and must
  render the switcher and search inline, and the compact fold ignores it.
  Hosted has no band, so neither applies.

## Sections toolbar: every view at once

- **Why the model stays one hook.** `useViewEphemeral` is a single `useState`
  over the whole map, so per-section models would overwrite each other's writes.
- **Why the field-extension fold is hoisted.** Contributed fields then subscribe
  once per surface, not once per section.
- **Why `hideWhenEmpty` hides while loading.** Not-known-yet is never painted as
  an empty section, and a section never flashes in and out.
- **Why the reveal is per section.** A starred page is selected both in
  Favorites and in the tree, as in Notion. Without the rule, the tree would
  expand to a favourite clicked above it and scroll the sidebar away from the
  click.
- **Limit:** section order is config order; sections cannot be drag-reordered.

## Toolbar controls

Rejected: named control props on the toolbar (`sortControl` / `filterControl` /
`fieldsControl` built by the host). They break the collection-consumer rule in
the most literal way, and no plugin could add a fourth control.

### Action controls: a trigger that acts

- **Why one pure function.** "Does it apply" and "what does it say and do" come
  from the same answer, so the label can follow the state and the two cannot
  disagree.
- **Why expand-all is reported by the view.** Only the view knows which rows it
  draws (the nested table's `rootId`, its filter scope). The control exists
  exactly while the active view nests something it can fold.

### A layout not known yet is a state, never an empty list

- **Why `Setting` stays separate from `Control`.** A control is a toolbar
  affordance; a setting is a section inside one control's panel. Flattening the
  two would put Properties, Group by and Fields in competition for the
  toolbar's single line.
- **Limit:** a `RowOrder` contributor that answers `null` while its *own* data
  loads reads as "no order", so the rows paint unsorted until it lands.

### One merged context

- **Why one context.** The settings menu *is* a control, so a separate
  "settings" context would duplicate it. `filter` and `sort` are the same
  controller objects the row pipeline uses, so a summary and what actually
  filters cannot come from two computations.
- **Why it is not around the view body.** View children have a deliberate
  contract (`DataViewRenderProps`). An ambient back door to `viewModel` would be
  a second, undocumented seam.

### The trigger is icon-only, everywhere

- Rejected: a width-dependent form, where the trigger spells itself out when
  wide and shrinks to a glyph when narrow. That is exactly the per-surface
  inconsistency the control registry exists to remove.
- Rejected: summary pills. Two of them ate the whole toolbar of the
  agent-manager sidebar, the app's narrowest DataView.

### The summary is pure, one function — and TEXT, never chrome

- **Why not a hook.** The trigger has to render without mounting its panel.
  Computing N summaries by mounting N panels would make every DataView subscribe
  to every control's data on first paint.
- **Why one function returning an object.** With separate `summary` and `count`
  functions over the same state, the two can disagree. Failure mode: the summary
  read "0 rules" while a value-less `bool` rule silently filtered. That is the
  bug `rule-resolution.ts` closes, and the summarizers import `isRuleActive` for
  the same reason.
- **Why "+N more" is spelled out in the accessible name.** A bare number beside
  a phrase is ambiguous without visual context.
- **Why operators format their own operand.** The operand's shape is the
  operator's: only `date · is between` knows it holds a pair of instants.
- **Why Settings has no summary.** A summary answers "what am I not seeing, and
  why". "Group by: Status" answers neither, and it would count itself into the
  compact badge as though something were hidden. Sort earns one because its top
  level is worth reading from a closed trigger.

### Panel bodies

- **Why panels are prop-less.** The wide bar and the compact fold mount them
  through the same host with nothing left to diverge on.
- **The trade-off: the settings control is always applicable.** A pure
  `isApplicable` cannot read another slot, so the control cannot self-hide when
  no `Setting` applies.
- **Failure modes behind the `Setting` contract:**
  - A setting that returns loose rows has no band and no rule.
  - A setting wrapped in a `div` turns that opaque box into the band, in place
    of the sections inside it.
  - A footer placed from inside one section sits above whatever contribution
    comes next. That is why "Show all fields" is a row, not the panel `Footer`.
- **Failure mode behind "read state through hooks".** A pushed page's `render`
  closure is captured on click, and the page replaces the root's subtree. Data
  passed down through the closure looks fine, then silently computes the page's
  second edit against the tree as it was before the first.

## An option carries its own presentation

- Rejected: a value→label map plus a parallel value→variant map. Every render
  site has to join them by hand, and they drift.
- **Why `BadgeVariant` lives in `badge/core`.** A data declaration in another
  plugin's `core` has to be able to spell it, and `core → web` is not a legal
  edge. Rejected: duplicating the union into `data-view/core`, since each
  concept gets one name.
- **Why inline editors stay untinted.** They draw `ToggleChip`s, and
  `BadgeVariant` is not `ToggleChip`'s vocabulary.
- **Why custom enum columns have no colour picker.** Muted is the right default
  for user values with no semantics.
- **Why a tint never reaches the server.** Server-side filter SQL never reads
  `label` or `options`.

### The Cell registry also says whether a type presents as a chip

- **Why the flag exists.** ` · ` is punctuation between two pieces of *text*.
  Chips already carry their own boundary. Failure mode without it:
  `name · [Web page] · [Daily] · [Failed]`, middots glued to pills, which reads
  worse than a two-line row.
- **Why it is a claim about the type, not the renderer.** Consumers then don't
  re-declare what the type already says (this is how Events keeps its "source
  type no longer installed" fallback).
- **The accepted cost:** an override that renders plain text for a chip-typed
  field loses its middots, which is only cosmetic.
- **Why one shared lookup with `useResolveCell`.** "Which contribution owns this
  field" cannot be answered two ways.

## Structured display data (`data`)

- **Why it is inert by construction.**
  - `makeSortComparator` drops a rule whose field has no `value`.
  - `isGroupableField` refuses a value-less field.
  - The filter picker lists only types with an operator set.
  - Search indexes `value` / `values` only.
- **Why a missing cell throws.** A blank cell would hide the real mistake: the
  type's cell plugin is missing from the composition.

## Row activation is PER ROW

- **Why handler presence is the fact.** There is no predicate beside the
  handler, so the two cannot disagree.
- **Failure mode behind "never wrap in a closure."** `Row` infers its element
  from `onClick`, and a closure is never null. So:
  - every row becomes a `<button>` with the `renderRow` children nested inside;
  - any control in the row body is invalid DOM;
  - the outer row eats the press;
  - a list where nothing activates announces every row as a button.

  The handler fired correctly the whole time, which is why the locking test
  asserts the DOM shape, not the callback.
- **Limit: the table is table-level.** `DataTable.onRowClick` is table-wide and
  has consumers outside data-view, so a non-activating table row is a
  live-looking row that does nothing. Lifting that requires changing
  `DataTable`.

### The click belongs to the row; the pencil belongs to the field

Rejected: click-to-edit on every cell.

- The row's primary action survived only in the slivers between columns, so a
  table of editable fields could not be used to open anything.
- A `div` with `onClick` was unreachable by keyboard.

The pencil is a real, focusable button, which gives keyboard users an editor.
It is always mounted and only faded, so revealing it reflows nothing.

**The nested table's primary label is the exception** (select-then-edit). It is
the navigation target itself, so there is no room beside it for a second
affordance.

### Where a row goes, declared by its owner (`CollectionRowActivation`)

**Why the list's own handler runs after, never instead.** The owner's link is
the navigation. The list's handler is the host's business with its own chrome
(the build popover closing itself).

## Row selection, and native row drag and drop

### `rowSelection` — a set, not a single id

- **Why ⌘/Ctrl-click toggles here.** On a Finder-class surface it is a selection
  gesture, not the new-tab link gesture. Middle-click still opens a new tab.
- **Why ranges run over rows as painted.** A collapsed folder's children are
  never in a range.

### `rowDrag` / `rowDrop` — HTML5 drag and drop, not dnd-kit

- **Why not alongside `hierarchy.onMove`.** Two gestures would claim one row's
  drag.
- **Why `"between"` draws a line, never a ring.** A ring reads as "into this
  row".
- **Failure mode behind "a gap has one spelling".** Spelled per row, one gap is
  two targets drawn on two edges, and the line hops as the pointer crosses the
  boundary between the two rows.
- **Why own rows cancel.** Dropping a row back where it was does nothing.
- **Why rows are `select-none`.** A press-and-drag across rows is a row gesture,
  never a text selection. An inline editor keeps its own selection.
- **Why the drop state is a per-view store read per row.** A moving drag
  re-renders only the rows it leaves and enters, never the whole list.

## Row tone: a row can read as inactive

- **Why a tone.** A switched-off, archived or finished row reads as inactive
  without spending a chip on saying so. Before `rowTone`, several plugins
  hand-rolled this separately.
- **Why it threads like `searchAccessor`, not like `density`.** `density` is a
  declaration *about the surface*, so it takes the chrome path. `rowTone` is a
  data accessor over rows, so it flows through the bundle for free, and the
  hosts need no change.
- **Why the flat table is a no-op.** Its only per-row seam,
  `useRowDecoration`, is already held by manual-order drag. Merging two
  decorations onto one hook is its own change.
- **Why reach for `rowTone` before `labelClassName`.** A tone is a statement
  about the row; a class is a statement about pixels.

## Density: how much room the surface gives the view

**Why the source bundle omits `density`.** It describes the surface, not the
data. A source contribution must not be able to spell a value the body would
then ignore.

## Table view options

**Why column captions are three-way.** A switch has no "default" position. As a
switch it would draw "off" over a grid table that does show its labels.

### The fold rule

- **Why the two halves are OR-ed.** The width half is involuntary: below the
  breakpoint the wide row does not fit, whatever is declared. The density half
  is voluntary: a 672px popover has the room and still wants the light form.
- **The result:** density removes the *need* for room but never asserts there is
  any. This is the single reason a surface cannot end up wide *and* folded by
  accident.

### The compact trigger is hover-revealed

- **Why the CSS group, not `useHoverReveal()`.** The state hook re-renders the
  whole DataView, every windowed row included, on each pointer enter and leave.
- **Why the group is on the bar, not the root.** On the root, every pass over the
  list is a reveal, so grazing a row flickers a control in the far top corner.
- **Why `open` pins it.** The panel is portaled, so the pointer leaves the hover
  group the instant it moves into the panel. The trigger would fade out from
  under the panel it opened.
- **Why only the query pins it.**
  - Filter, sort and group-by are durable narrowings in the config row. They are
    part of what the named view *is*: "Failed builds" is not hiding anything.
    Pinning on them reports the view's own definition back as though it were an
    accident.
  - A query is an ad-hoc gesture. With the bar folded it leaves no other trace,
    so the narrowed list reads as the whole view.
- **Rejected attempts:**
  - Pinning on `activeCount > 0`. Surfaces author a default sort in config, so
    the trigger never hid.
  - A `hidesRows` flag on the summary. Once filters stopped pinning, nothing set
    it, and a contract field with no implementer is speculative generality.
- **Why the badge still counts filter and sort.** "N things configured" is a
  different, correct statement. Only visibility at rest asks the narrower
  question.
- **Why one behaviour everywhere.** The alternative is two visually different
  compact bars whose difference nothing in the UI explains.

### Single-line list rows are the default

- **Why default shrink weighting is enough.** The longer leaf yields more, and
  the subtitle (the `·`-joined metadata run) is normally the longer one. That
  matches the intent (the title identifies the row) without a shrink-priority
  primitive invented for one call site.
- **Why slot widths only grow.** A column that shrank as rows scroll away would
  move every row on screen.
- **Why time goes last.** The row's right edge is its time.
- **Why the blast radius is small.** High-traffic lists (conversations sidebar,
  mail threads, events, deploy history) override `renderRow` wholesale. Only the
  field-driven default changes.

## Quiet rows and common-value elision

- **Why quiet.** A row is a sentence of values. A row of filled chips reads as
  a toolbar.
- **Why elide a common value.** A value held by ≥ 60% of rows is the default,
  not information.
- **Why each guard exists:**
  - *Chip-presenting only, never editable:* an elided editable cell would take
    its pencil with it.
  - *No empty row for the field:* next to a blank, an elided cell would also
    read as "no value".
  - *Only once rows are complete:* a paged read's shares move as pages land, so
    a value would appear and vanish as the reader scrolls.
- **Why the population is `rows`, not the search result.** Typing must not
  re-flow which values show.
- **Limit:** which field a value belongs to comes from position alone. A field
  role model (status → leading glyph, time → right edge, path → low priority,
  declared once per entity field) is not built yet. The time-last rule is its
  first, type-derived approximation.

## Per-item actions

**Why a per-consumer factory, not a global slot like `View`.** Each consumer's
row type is disjoint (`Block`, `TaskListItem`, `Agent`). A global slot would
force `ComponentType<ItemActionProps<unknown>>` plus a runtime `kind`
discriminator to keep one app's Delete off another app's rows. Per-consumer
slots are isolated by construction and keep full `TRow` typing.

### The zone axis: does this action live at rest?

- **Why zone and `useActive` belong to the action.** Declared once, so every
  view gives the same answer.
- **Why the rest rule lives in one cell.** The at-rest and hover arms can then
  never both draw an action.
- **Why both slot flags are required.** A new view type must answer them; a
  default would silently drop or misplace actions.
- **Why a demoted primary always rests.** The row's main verb has nowhere else
  to show, so a table keeps Play painted on every row.
- **Why the list has no persistent slot.** A reserved trailing region would
  take width from the title in the app's narrowest surfaces (the Pages sidebar).
- **Why not merged with `action-presentation`.** That axis answers *what form an
  action draws as*; `zone` answers *whether it is painted at rest*. They
  compose.

## Field extensions

- **Why there is no second per-row render slot.** The field schema is already
  the generic seam (it buys sort, filter and a column), so a private "extra
  meta" slot beside it is always a duplicate.
- **Failure mode behind `pending`.** Whatever `value` returns while the field's
  own read loads lays the rows out by a claim. An enum's `null` is its "None"
  bucket, so every row gets filed under "None", then moves.
- **Why the fold is a recursive component.** A `.map` over contributed hooks
  breaks the rules of hooks.
- **Why it wraps the model before the controllers.** A contributed `int` or
  `date` field shows up in Sort, Filter and the table columns for free.
- **Why "checked where declared" puts a contributor's check in its own
  `render`.** Its item boundary contains the crash, and the error names the
  contributor.

### Field sections: a band per contributor

- **Why sections.** A schema several plugins contribute to is otherwise a flat
  list of forty columns, with nothing saying where each came from.
- **Why the fold stamps the section.** A plugin then cannot spell its band two
  ways across forty columns, forget it on the fortieth, or file a column under
  another plugin's name.
- **Why `section` is required and nullable.** `null` ("ordinary host fields")
  is a real answer. A defaulted optional field would file a forgetful arm's
  columns under the host's own name, with nothing to catch it.
- **Why `ControlPanel.Subhead`.** It follows the panel's label rails. Because it
  carries no rail class of its own, it is also right in `field-picker.tsx`'s
  bare `InlinePopover`, where there is no panel.
- **Trade-off of "band order is body order":** a column can never sit between
  two bands in the table while Properties shows it inside one. The cost is
  deliberate: columns from two sources cannot be interleaved.

## Filtering

The language design:
[2026-09-25-global-unified-filter-language](../../../../research/2026-09-25-global-unified-filter-language.md).

- **Why operators lower instead of predicating.** One answer (`undefined` =
  incomplete) is both the evaluator's no-op gate and the chip counter's
  `isRuleActive`, so the two cannot disagree.
- **Why relative time is lowered on the client.** The language has no clock.
  `readsClock` is recorded generically (`ctx.now` is a getter), so data-view
  marks a filter clock-dependent without naming the date type.
- **Why a dangling rule waits for the deferred tier.** Measured on the Pages
  sidebar: Favorites listed every page before `starred` registered. The
  contributor may simply not have registered its field yet.
- **Why `useRowFilter` returns a union.** No caller can mistake "a filter I
  could not run" for "no filter".
- **Why the language stays strict.** Coercion happens in one adapter
  (`coerceToDomain`), not inside the evaluator.
- **Why preset deletion has Undo.** A lost filter tree cannot be reconstructed.
  The trash sits in `ControlPanel.Row`'s `actions` slot, so the click target is a
  sibling of the row's button, not its ancestor.

### A source's filter: nothing falls back to the client

- **Failure mode the refusal prevents.** Silently running the rest of a filter
  shows rows the view claims to hide.
- **Why over-bounds trees are an error.** A silently trimmed filter is the same
  lie.

### Live sources (`source`): a `network/live` collection as live key-range pages

- **Why each prop is refused:**
  - `rowKey`: the runtime keys its deltas by the collection's `id`.
  - `hierarchy`: a hierarchy over a paged set orphans children.
  - `manualOrder`: a rank would reorder server-sorted pages.
- **Why `awaitingScope`.** The list shows one loading state with its toolbar
  already up. Rejected: a bare skeleton that the toolbar then pushes down.
- **Why a scoped column is never offered in Filter.** A rule over it could only
  restate the scope or contradict it into an empty list.
- **Why facet options are read.** The filter input then renders loading or the
  failure with Retry, never an empty grid.
  - They are value-sorted, never in count order, and keep their identity across
    a count change.
  - The readers are sibling components, so a scope arriving under a mounted
    body does not remount it.
- **Why a `column` on an in-memory DataView throws.** It would be silently
  ignored.
- **Group-by lowering:**
  - Sections read only while active, so thirty groups below the fold read
    nothing.
  - Sections follow the bucket ordinal, never the server's count order.
  - A grouping over a derived value is not offered: its sections could only
    describe what happens to be loaded.
- **Why `useHeldHeight`.** A view switch or filter change must not shrink the
  page under a reader scrolled down; the scroller would clamp them up.
- **Why `setSort` throws for an unsortable field.** A header click can then
  never persist a rule the source refuses.

### Typed fields are the generic extension point

**Why a typed field instead of a toolbar chip.** Filter, sort, grouping and
saved views all operate on the same field schema, so a new typed field unlocks
all of them at once with zero chrome code.

## Per-view visible fields (Properties)

- **Why a hidden entry keeps its place.** Hiding then showing a field returns it
  where it was.
- **Why a later-added field arrives hidden in a customized view.** Notion
  parity. Nothing flags it for review because the field catalog is code, not
  config: adding a field moves no config hash, and arriving hidden changes
  nothing the view shows.

### `FieldDef.visible` — a field can be a dimension without being printed

- **Failure mode if only the body reads it.** Properties shows the field as on
  while the body leaves it out, and the first click on it visibly does nothing.
- **Why sort/filter/search are unaffected.** By construction, not care: views run
  `useDataViewSections` over the full `fields` and call `resolveBodyFields`
  separately.
- **Why "Show all fields" resets to `null`.** That returns to the schema default,
  so a `visible: false` field goes back to hidden instead of appearing.

## Placement: always natural-height, never owns a scroll

- **Why one scroller.** The single-scroll model removes the whole class of
  nested and severed-scroll bugs.
- **Why the sticky toolbar needs no offsets.** The root is each DataView's own
  containing block, so stacked DataViews hand off automatically, with no
  `active` toggling or computed `top`.
- **Why the dev guards log instead of throwing.** They stay safe at overlay and
  SSR edges.
- **Why the mask guard is a runtime check.** The surface is a runtime ancestor
  that a lint cannot see.

## Row virtualization (`VirtualRows`)

- **Why it is its own leaf primitive.** list, table and `primitives/tree` share
  it without a layering inversion.
- **Why it self-discovers the scroller.** The DataView never owns its scroll, so
  windowing binds to the pane's one scroller, and the sticky toolbar's height
  folds into the measured `scrollMargin` automatically.
- **Why windowing is always within a section.** Every header stays mounted, so
  `StickyStack` can measure it.

Background:
[2026-06-18-data-view-row-virtualization](../../../../research/2026-06-18-data-view-row-virtualization.md).
