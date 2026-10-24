# The gallery card owns its own chrome: a body-only hatch, and a zone for actions that live at rest

## Context

`gallery-view.tsx:195-197` short-circuits the entire card:

```ts
if (options.renderCard) {
  return <div className="contents">{options.renderCard(row)}</div>;
}
```

Everything below that line is discarded — `actions={<itemActions.Row …/>}` (the shared
`row-actions` cluster), `selected={key === props.selectedRowId}`, `onActivate →
onRowActivate`, the field-driven media/title/body, and the aggregate `×N` badge. A
consumer that has *already declared* an affordance on `<DataView>` loses it by supplying
an unrelated option.

Sonata's library is the live casualty. It declares `itemActions={Library.SongActions}`
(`song-library.tsx:150`) **and** `viewOptions.gallery.renderCard` (`:166`), so its Play
action reaches only the TABLE view. The gallery card therefore grew its own
hover-revealed delete button on `hoverRevealTarget` (`song-card.tsx:113-132`) — a second
row-action cluster, invisible to `row-actions/no-raw-actions-slot` because it is inline
JSX with no `actions`-shaped prop. The same records expose different affordances
depending on which view is showing, and the card carries the exact reveal implementation
the convergence in `f7110e8c3` existed to end
(`research/2026-08-06-global-row-action-cluster-convergence.md`).

**The question is not how to patch Sonata.** It is what the generic card was missing that
made a full-card override the only option.

### Five deltas, and what each one actually was

| # | Sonata's card does | Verdict |
|---|---|---|
| 1 | A leading icon block **beside** the title | **Real gap.** `DataCard.media` is a full-width cover *above* the body. The list view solved this long ago with `ListViewOptions.leading` → `Row`'s `icon`; the gallery never got the twin. |
| 2 | An **always-visible** Play/Pause button | **Real gap.** `RowActions.alwaysVisible` is a property of the whole cluster; `ItemActionContribution` carries `{id, component, order}` and cannot say "I belong at rest". Note `PlaySongAction` is *already* contributed as `Library.SongActions({id:"play"})` — the card duplicates it as a bespoke filled circle. |
| 3 | `Library.CardMeta`, a private per-card render slot | **Not a gap — a duplicate.** `playback-history` publishes the *same two values* through `CardMeta` (`PlayStats`) **and** `Library.Fields` (`PlaybackFields`). A per-row datum is a `FieldDef`; the generic seam already exists. |
| 4 | A "currently playing" ring distinct from `selected` | **Not a gap.** `song-library.tsx:151` already passes `selectedRowId={currentSongId}`, and `DataCard` already paints `ring-2 ring-primary` on `selected`. Only the predicate differs (`isCurrent && isPlaying` vs `isCurrent`), which is a consumer choice. |
| 5 | A hand-rolled per-card delete | **Not a gap — debt.** It should always have been a `Library.SongActions` contribution. There is no delete item action at all today, so the *table* has no delete either; contributing one fixes both views. |

Two gaps, one duplicate, two pieces of debt. The escape hatch was load-bearing for none
of them.

### Decisions taken (with the user, before this doc)

- **Narrow, don't delete.** `renderCard` → `renderBody`: body only, `DataCard` always
  built. Deleting the hatch outright fixes nothing further (a body hatch cannot drop an
  affordance) and would force look regressions on the two tweakcn surfaces purely to
  satisfy a rule. The list's identical `renderRow` has six live consumers, so the
  body-composite shape is real; removing the gallery's twin while the list keeps its own
  leaves no principle, just history.
- **Per-action zone, not per-cluster.** An action declares whether it belongs at rest;
  one shared rule decides what a view without a persistent slot does with it.
- **Scope:** the gallery primitive + Sonata, plus deleting `TreeViewOptions.renderRow`
  (zero consumers, same all-or-nothing shape — the pattern someone copies next). The two
  tweakcn `renderCard` call sites are forced by the rename and are included.
- The list's `renderRow` is **out of scope** and filed as its own task
  (`task-1786116536780-7dflvq`), which requires a per-surface visual account of all six
  consumers before any recommendation.

## Design

### 1. `renderBody` — one card construction site, always

```ts
// gallery/core/internal/types.ts
export interface GalleryViewOptions<TRow> {
  leading?: (row: TRow) => ReactNode;     // NEW — inline block beside the title (list parity)
  renderBody?: (row: TRow) => ReactNode;  // replaces renderCard — the BODY, never the card
  size?: "sm" | "md";                     // NEW — card density (list parity), default "md"
  cover?; coverField?; minCardWidth?; showCreateCard?;   // unchanged
}
```

`renderCell`'s early return is deleted. Every cell — field-driven or not — is:

```tsx
<DataCard
  size={options.size}
  selected={key === props.selectedRowId}
  onActivate={() => props.onRowActivate?.(row)}
  media={media}
  leading={options.leading?.(row)}
  actions={revealed?.({ row, hasChildren })}
  footer={persistent?.({ row, hasChildren })}
>
  {options.renderBody ? options.renderBody(row) : fieldDrivenBody}
</DataCard>
```

The aggregate `×N` `Pin` wrap stays where it is and now applies to every card, custom
body included.

**`DataCard` gains two regions/axes** (`data-card.tsx`):

- `leading?: ReactNode` — rendered in a `direction="row"` line with the body
  (`{leading}<div className="min-w-0 flex-1">{children}</div>`), below `media`. Absent →
  byte-identical to today.
- `size?: "sm" | "md"` — `md` (default) keeps `p-lg`/`gap-md`; `sm` is `p-card`/`gap-sm`
  with the title at `caption`. `footer` already exists and was never used by the gallery;
  it is now the persistent-action slot.

### 2. `ItemActionZone` — an action declares whether it lives at rest

```ts
// data-view/core/internal/types.ts
export type ItemActionZone = "persistent" | "revealed";

export interface ItemActionsDescriptor<TRow> {
  /** `zone` omitted ⇒ every contribution, whatever its zone. */
  Row: ComponentType<ItemActionProps<TRow> & { zone?: ItemActionZone }>;
  /** Which zones actually have a contribution — so a view never paints an empty cluster. */
  useZones: () => Record<ItemActionZone, boolean>;
}

// data-view/web/internal/define-item-actions.tsx
export interface ItemActionContribution<TRow> {
  id; component; order?;
  /** Deserves a permanent slot where the view has one. Default "revealed". */
  zone?: ItemActionZone;
}
```

`defineItemActions` filters inside its existing `<slot.Render>` callback and mints
`useZones` off `slot.useContributions()`. Both `zone` defaults keep every existing
consumer and every view byte-identical until it opts in.

**The degradation rule lives in exactly one function**, exported from `data-view/web` —
not in four view children, which is precisely the divergence the convergence doc exists
to prevent:

```ts
export function useItemActionZones<TRow>(
  itemActions: ItemActionsDescriptor<TRow> | undefined,
  opts: { hasPersistentSlot: boolean },
): {
  persistent: ((p: ItemActionProps<TRow>) => ReactNode) | null;
  revealed:   ((p: ItemActionProps<TRow>) => ReactNode) | null;
};
```

- `hasPersistentSlot: false` ⇒ `persistent` is `null` and `revealed` renders
  **unfiltered** (all zones). A persistent action is demoted to hover, **never dropped**.
- `hasPersistentSlot: true` ⇒ each arm is non-null only when `useZones()` says that zone
  is populated, so no view ever paints an empty `RowActions` box.
- `hasPersistentSlot` is a **required** argument: a new view type cannot forget to answer.

| View | `hasPersistentSlot` | Persistent placement |
|---|---|---|
| gallery | `true` | `DataCard.footer` → `<RowActions pin={null} alwaysVisible>` (in flow, no mask needed) |
| table | `true` | the reserved trailing `auto` track, immediately before the revealed cluster |
| list | `false` | — demoted |
| tree | `false` | — demoted |

**Why list and tree say `false`, on purpose.** Neither row has a reserved trailing
region; a permanent one would take width from the title in the narrowest surfaces in the
app (the Pages sidebar). No consumer needs it today, the degradation is visible and
meaningful, and it is a one-flag change when a surface earns it. `primitives/css/row` and
`primitives/tree` are therefore **untouched**.

`data-table` gains one optional prop, `rowPersistentActions?: (row, index) => ReactNode`,
rendered in the existing trailing track as `<RowActions pin={null} alwaysVisible
className="justify-end">` before the revealed cluster. The track is already `auto`, so
the reservation is free.

**`primitives/action-presentation` is a different axis — do not merge them.** It answers
*what form does this action draw as* (ghost icon button vs labelled menu row) and is read
by `IconButton`. `zone` answers *is the cluster painted at rest*, which `RowActions` owns
on its outermost node together with the `Pin mask` scrim. They compose: a persistent
cluster is `mode="inline"`; an `overflow` bucket inside the revealed cluster is
`mode="menu"`.

**Rejected, recorded so they are not re-derived:**

- *A `pinned` reorder container node type* (sibling of `overflow`). Structurally
  impossible: a reorder container wraps its members *in place*, inside the one cluster the
  middleware renders. `RowActions` fades its outermost node, so an `alwaysVisible` group
  nested inside a fading `Pin` still fades. `overflow` works only because a dropdown is a
  local wrap; a persistent slot must leave the cluster.
- *Per-view-instance config* (`"persistentActions": [...]` on the `view` blob). Recreates
  the bug in config shape: an author can promote Play on the card and forget the table
  row. Per-surface *hiding/overflow* stays authored in the existing reorder file;
  *importance* is a property of the action.

### 3. `Library.CardMeta` is deleted; its three contributors become fields

A per-row datum is a `FieldDef` — that is the generic seam, and it also buys sort, filter
and a table column. All three contributors express cleanly.

1. **`PlayStats`** — a pure duplicate of `PlaybackFields`. Delete the component and the
   contribution; add no field. Recover the copy with a one-line `cell` on `playCount`
   (`n ? \`${n} plays\` : "Not played yet"`).
2. **`MidiCardMeta`** → `sources/midi` contributes `MidiFields` into `Library.Fields`:
   `{ id:"trackCount", label:"Tracks", type:"int", value: s => map.get(s.id)?.trackCount ?? null,
   cell: s => …"N tracks", sortable:true, align:"end", width:"5rem" }`. Needs a new
   `useSongMidiMap()` in `sources/midi/web/hooks.ts` (mirroring `usePlaybackHistoryMap`
   over the same live resource), exported from its web barrel. `cell` returns `null` for
   non-MIDI songs, so the card stays source-agnostic.
3. **`SourceDeletedBadge`** → `sources/midi/folders` contributes its own field:
   `{ id:"sourceMissing", label:"Source", type:"bool", value: s => …sourceMissing ?? false,
   cell: s => missing ? <Badge variant="destructive">Source deleted</Badge> : null }`.
   `bool` has a registered cell **and** filter operator set, and `FieldDef.cell` overrides
   the inherited checkbox. "Show me songs whose file vanished" becomes a filter preset.
   Kept a separate contributor from `midi`'s — `sourceMissing` is the folders plugin's
   semantics, and contributor-per-plugin is the boundary rule.

### 4. Sonata

- **Delete `song-card.tsx`.** Its five parts land as: `leading` (the `MdMusicNote`
  block), the existing `title`/`composer`/`duration` fields, `PlaySongAction` with
  `zone:"persistent"`, a new `DeleteSongAction`, and `selectedRowId` for the ring.
- **New `delete-song-action.tsx`** — `RowActionButton` + `deleteSong`, contributed as
  `Library.SongActions({ id:"delete", component: DeleteSongAction })`. This is also the
  table's first delete.
- `slots.ts` — remove `CardMeta`; rewrite the `SongActions` doc comment, which currently
  *documents the bug* ("a custom `renderCard` bypasses `itemActions`").
- `song-library.tsx` — drop `renderCard`, add `leading`; add
  `cell: (s) => s.composer ?? "Unknown"` to the `composer` field so the fallback the card
  owned survives (the table gains it too — deliberate).
- **Config.** `config/apps/sonata/library/sonata.library.jsonc`: author `visibleFields`
  on the `cards` row. The schema goes from 7 fields to 9, and the gallery stacks one
  caption row per field, so an unauthored card would show eight rows. Recommended:
  `["title","composer","duration","playCount","trackCount","sourceMissing"]`. Delete
  `sonata.library.card-meta.jsonc` + its `.origin.jsonc`; `sonata.library.fields.jsonc`
  gains the two new contributor keys, so its origin `@hash` shifts —
  `./equin build` regenerates it and `config-origins-in-sync` blocks `push` until
  the new hash is copied over. Same for `sonata.library.song-actions.jsonc` (new
  `delete` key).

### 5. tweakcn — a rename, plus dropping duplicated card chrome

Both sections rename `renderCard` → `renderBody` and strip the `Card` wrapper their body
no longer needs.

- `community-theme-card.tsx` — drop the outer `<Card interactive role="button" tabIndex
  onClick onKeyDown className="rounded-lg p-lg">`; keep the `h-16` colour strip and the
  name/curated line as the body. Activation moves to
  `onRowActivate={(t) => applyTheme(t.id)}` on the `<DataView>` (absent today). The
  `isPending` `opacity-50` moves onto the body wrapper it still owns.
- `quick-theme-swatch.tsx` — the `<Row>` becomes the body (dots + name); the section
  passes `size: "sm"`.

### 6. `TreeViewOptions.renderRow` is deleted

`tree/web/internal/types.ts:26` + `tree-view.tsx:326-327`, zero consumers, full-row
replacement — the same disease with none of the mitigations. Remove it and its
`CLAUDE.md` entry.

## Guardrail

**A structure, not a rule.** After this change the gallery has exactly **one**
`DataCard` construction site, and `renderBody` cannot reach the card. There is no second
path an affordance can be absent from, so there is nothing left for a lint rule to catch —
the class of bug is unrepresentable rather than detectable.

`useItemActionZones` is the second half: adding a future declared affordance is one edit
in the shared helper plus one placement per view, and `hasPersistentSlot` being a required
argument means a new view type must state its answer.

**Deliberately no new lint rule.** Every candidate for this class is satisfiable in place,
which is the convergence doc's own test:

- *"a `*ViewOptions` member must not be named `render<Container>`"* — a shape rule,
  defeated by renaming the key.
- *"`Pin` + a hover-reveal class is a row cluster"* — already rejected in the convergence
  doc (`:186-189`): it flags ~12 legitimate media overlays and would not have caught the
  historical `w-0` duplicate.
- The existing `row-actions/no-raw-actions-slot` is name-based on props, and `SongCard`
  takes `{song, onOpen}` — no `actions`-shaped prop, so no name-based rule reaches it. The
  reason its delete button existed is that `renderCard` gave it a card to hang on; remove
  the card and the hand-roll has nowhere to live.

Record that limitation plainly in `gallery/CLAUDE.md` rather than shipping something that
looks like a guard and is not one.

## Files

**data-view (core + web)**
- `core/internal/types.ts` — `ItemActionZone`; `ItemActionsDescriptor` gains `zone?` on
  `Row` and `useZones`.
- `web/internal/define-item-actions.tsx` — `zone?` on the contribution; zone-filtering
  `Row`; `useZones`.
- `web/internal/use-item-action-zones.ts` — **new**, the one degradation rule.
- `web/index.ts`, `core/index.ts` — exports.
- `CLAUDE.md` — "Per-item actions" gains the zone axis + the degradation table; "Field
  extensions" gains *there is no second per-row render slot — a per-row datum is a
  `FieldDef`*.

**gallery**
- `core/internal/types.ts` — `renderCard` → `renderBody`; add `leading`, `size`.
- `web/components/data-card.tsx` — `leading` region, `size` axis, `footer` now used.
- `web/components/gallery-view.tsx` — delete the early return (`:195-197`); always build
  `DataCard`; wire `leading` / `renderBody` / `size` / both action zones.
- `CLAUDE.md` — rewrite "Custom card"; record the guardrail's honest limits.

**table / tree / data-table**
- `table/web/components/table-view.tsx` (`rowActions` at `:195`) — both zones,
  `hasPersistentSlot: true`.
- `primitives/data-table/web/internal/data-table.tsx` — `rowPersistentActions` prop
  (+ `CLAUDE.md`).
- `list/web/components/list-view.tsx`, `tree/web/components/tree-view.tsx` — route through
  the helper with `hasPersistentSlot: false` (no visual change).
- `tree/web/internal/types.ts` + `tree-view.tsx:326` + `tree/CLAUDE.md` — delete
  `renderRow`.

**Sonata**
- **delete** `library/web/components/song-card.tsx`,
  `playback-history/web/components/play-stats.tsx`,
  `sources/midi/web/components/midi-card-meta.tsx`,
  `sources/midi/plugins/folders/web/components/source-deleted-badge.tsx`.
- **new** `library/web/components/delete-song-action.tsx`,
  `sources/midi/web/components/midi-fields.tsx`,
  `sources/midi/plugins/folders/web/components/source-missing-field.tsx`.
- `library/web/slots.ts`, `library/web/index.ts`,
  `library/web/components/song-library.tsx`,
  `library/web/components/play-song-action.tsx` (contribution site gains
  `zone:"persistent"`).
- `playback-history/web/{index.ts,components/playback-fields.tsx}`;
  `sources/midi/web/{hooks.ts,index.ts}`; `sources/midi/plugins/folders/web/index.ts`.
- `CLAUDE.md` × 4 (library, playback-history, midi, folders).
- `config/apps/sonata/library/` — edit `sonata.library.jsonc`; delete
  `sonata.library.card-meta*.jsonc`; re-stamp `sonata.library.fields.origin.jsonc` and
  `sonata.library.song-actions.origin.jsonc`.

**tweakcn**
- `community-browser/web/components/{community-browser-section,community-theme-card,quick-theme-section,quick-theme-swatch}.tsx`.

Registration is filesystem-derived — never hand-edit `web.generated.ts`.

## Verification

1. `./equin build`; confirm `status: ok` in
   `~/.singularity/worktrees/<wt>/build-status.json` (never infer from a `build-*.log`).
   Re-stamp the shifted config `@hash`es and rebuild.
2. `./equin check` — `type-check`, `eslint`, `plugin-boundaries`,
   `plugins-doc-in-sync`, `reorderable-slots-in-sync` (deleting `Library.CardMeta` removes
   a slot), `config-origins-in-sync`, `config:overrides-authored`, `data-views-in-sync`,
   `tailwind-scan-covers-classes` (the new `size="sm"` classes), `layout-geometry`.
3. `./equin test plugins/primitives/plugins/data-view plugins/apps/plugins/sonata/plugins/library`
   — both buckets.
4. `gallery/web/__tests__/data-card-actions.test.tsx` — its cases still hold. **Add** the
   one this change exists for: rendering `GalleryView` with `itemActions` **and**
   `options.renderBody` still produces the `RowActions` cluster. Add a second asserting a
   `zone:"persistent"` contribution lands in the footer while a `revealed` one lands in
   the pinned cluster. Also re-run `inline-edit.test.tsx`.
5. `bun plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts` against the
   Sonata library gallery — the card is now a real `row-actions` host, so the
   click-must-not-pin invariant applies to it.
6. Drive the app at `http://<worktree>.localhost:9000/sonata`:
   - Play is visible at rest on every card **and** every table row; Delete appears on
     hover in both; clicking either never opens the player.
   - The currently-loaded song rings in both views.
   - Grouping by `source` still renders grouped card sections; the `×N` badge still pins
     top-left where an aggregate exists.
   - Theme customizer + quick-theme popover: cards paint, applying a theme still shows its
     busy state, clicking a card applies it.

## Accepted deltas

State these up front; they are the price of one card implementation.

- **Sonata's card gets taller.** Today's compact meta strip (plays · last played, on one
  line) becomes one caption row per field. Mitigated by the authored `visibleFields`
  above — a config decision now, not code.
- **Play is always visible in the TABLE too.** That is the "one declaration, every view
  honours it" outcome, and it should be stated rather than discovered. Its filled-circle
  treatment on the card becomes a `RowActionButton` ghost; a filled emphasis, if wanted,
  belongs as a `variant` on `RowActionButton`, never hand-rolled.
- **A composer-less song reads "Empty", not "Unknown"** — see the correction below.
- **The quick-theme picker's rows grow ~28px → ~40px** (`size="sm"` = `p-card`), so a
  `max-h-72` popover shows roughly 10 themes above the fold instead of 13, on a card
  surface instead of a transparent bordered chip. Tunable in the look-pass without code
  if `sm` should be tighter still.

## Corrections found during implementation

Three things above did not survive contact; recorded so they are not re-derived.

1. **The `composer` "Unknown" fallback is not reachable, and was dropped.** §4 specified
   `cell: (s) => s.composer ?? "Unknown"`. `composer` declares `onEdit`, so `FieldCell`
   routes it through `EditableCell`, which paints its own italic *"Empty"* hint whenever
   the raw value is empty and never reaches `cell` — the `cell` would have been inert code
   asserting a behaviour it does not produce. Removed. Both views now read "Empty", which
   is the better affordance for an editable field anyway (it invites the edit). Restoring
   a custom word would need an empty-placeholder override in `editable-cell.tsx`, which is
   a separate change.
2. **`sourceMissing` is labelled "File", not "Source".** §3 specified `label: "Source"`,
   which put two columns both headed "SOURCE" in the table — the library's own `source`
   enum (which input source a song came from) and this one (does the backing `.mid` still
   exist). The badge copy moved with it: "Source deleted" → "File missing".
3. **The table's two clusters share one grid track.** §2 has the persistent cluster
   rendered "immediately before the revealed cluster" in the trailing `auto` track. Two
   `RowActions` cannot both be direct children of `data-table`'s subgrid row — a subgrid
   has no implicit tracks, so the second is clamped into the last track and paints over
   the first. When a persistent cluster exists the two now sit inside one
   `Stack direction="row" justify="end"` occupying that single track. With only
   `rowActions` present the row markup is byte-identical to before.

Also removed on the way past: `TreeRowNode`, a `tree` web-barrel export whose only reason
to exist was the deleted `renderRow`.

Two more found by looking at the deployed app rather than the tests:

4. **The gallery's persistent cluster needed `justify="end"`.** Left-aligned, a lone Play
   icon under the card body reads as stray content. It is composed through
   `<Stack direction="row" gap="none" justify="end">` — `layout/no-adhoc-layout` correctly
   rejects a raw `justify-end` class, and unlike `data-table` (whose subgrid track forbids
   a wrapper, hence its per-site disable) the card can just wrap.
5. **`playCount`'s column was 5rem, sized for digits, not for its `cell`.** "Not played
   yet" clipped mid-word in the table. Now 8rem.

### A pre-existing `Grid` bug, found on the way

`primitives/css/grid` sets `style={{ gridTemplateColumns }}` and then spreads `{...rest}`
— which still carried the caller's `style`. So **any fixed-column `Grid` that also paints
a background silently loses its column geometry**, collapses to one column, and overflows
its container. `CommunityThemeCard`'s colour-bar preview is the only caller in the repo
passing `style` to a `Grid`, so it was the only visibly broken one — and it was broken
*before* this task (verified against the merge-base: the old card had the identical
`<Grid cols={6} … style={{backgroundColor}}>`).

Fixed in the primitive by merging the caller's style **under** the track list: Grid owns
its column geometry — it is a closed prop surface, not a `grid-template` passthrough — so
an unrelated caller style must not be able to erase it. Same failure class as this whole
doc, one layer down.

## Follow-ups (not in scope)

- `research/2026-08-06-global-row-action-cluster-convergence.md` specified
  `plugins/primitives/plugins/row-actions/e2e/cluster-parity.ts`; **it was never
  written**, so no view has browser proof of anchor stability / held-open-while-menu-open.
  After this change Sonata *is* the gallery `itemActions` consumer the doc said did not
  exist, so the hole is finally closable.
- The list's `renderRow` — `task-1786116536780-7dflvq`.
- A `variant`/`emphasis` axis on `RowActionButton`, if the flat Play button reads as a
  downgrade in the look-pass.
