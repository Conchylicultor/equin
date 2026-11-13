# Surfaces own the inset, content declares none

Status: plan (designed by one agent, reviewed adversarially by another, reconciled here).
Extends [`2026-08-17-global-inset-ownership-rail-contract.md`](2026-08-17-global-inset-ownership-rail-contract.md)
and [`rail/CLAUDE.md`](../plugins/primitives/plugins/css/plugins/rail/CLAUDE.md); does not replace them.

## Context

The Places sidebar's tag search sat flush with the sidebar edge (fixed locally in
`cb5409a9cc`: a `p-sm` wrapper at `plugins/tag-tree/plugins/picker/web/components/tag-picker-panel.tsx:158`).
`SearchInput appearance="menu"` has no outer spacing by design; `TagPickerPanel` is hosted in a
`padding="none"` popover (`tag-picker-popover.tsx:41`) **and** in the bare body of a `Column`
(`places-map/web/components/tag-sidebar.tsx:190`), so nobody inset it. The local fix is one more
call site remembering to pad — the same decision that is made by hand everywhere:

**Audit** (TypeScript AST over every non-test `.ts/.tsx`):

| | uses | files |
|---|---|---|
| padding/margin classes in feature plugins | 1,081 | 334 (220 plugins) |
| … in primitives / ui / framework | 354 | 152 |
| `<Inset>` in feature code (padding by props) | — | 112 |
| `insetClass()` in feature code | — | 15 |

Values are already governed (`spacing/no-adhoc-spacing` bans numeric/arbitrary, `space-ramp/no-dead-spacing`
bans margins: ~15 arbitrary values left). **Placement is not**: who pays an inset is chosen per call site.
Roles of the 1,081 (heuristic, ±10%): item/control inner padding 236 · hand-rolled bands
(`border-b px-* py-*`, ≈115 bands) 227 · region/surface inset 183 · vertical rhythm 163 · empty-state text 69 ·
table cells 68 (63 in `stats/plugins/responsiveness/web/components/responsiveness-section.tsx`) ·
small wrappers 62 · indent 40 · `ml-auto`/`mx-auto` 33.

The rail contract (08-17) already says *the edge owner owns the rail*, but only some surfaces adopted it and the
static check "a box owning an inset must publish it" was deferred (doc :273-277):

| Surface | Today |
|---|---|
| `PopoverContent`/`OverlayPanel` | rail (`POPOVER_PADDING`, default `panel` = `--popover-pad` md; `popover-width.ts:174`) |
| `DropdownMenuContent` | rail-xs (`dropdown-menu.tsx:80`) |
| `DialogContent` | rail-lg (`dialog.tsx:188`) |
| `ControlPanel` | `cp-panel` owns, publishes the sum (`app.css:1610`) |
| `SectionCard` body | `rail-x-lg pb-lg` (`section-card.tsx:179`) |
| app-shell sidebar | `rail-owe-sidebar` + `rail-follow` bands (`app-shell-layout.tsx:353`) |
| **`Column`** | **nothing** (`css/plugins/column`) — 26 feature files |
| **Pane body** | **nothing**; every pane pads its own (`config-detail.tsx:148` p-md, `report-detail.tsx:74` p-md, `read-set-view.tsx:183` p-lg, `attempt-pane.tsx:233` Inset sm + children `px-sm`) |
| `Card` | plain `p-card`, publishes nothing |
| `Placeholder` | hard-coded `px-md py-sm` (`placeholder.tsx:12`), 165 feature uses |

Three owners are missing outright: **a column/region inset**, **a mid-content rule band**, **a pane body inset**.

## Principle (adds to the five rail rules)

1. **A region that holds content is opened by a surface that publishes.** Popover, menu, dialog, column,
   pane body, section card, control panel. Content inside lands on the rail by doing nothing.
2. **A rule-bearing strip is a member, not a class recipe.** Edge strips are the surface's own `header` /
   `footer` slots; a rule in mid-content is a `Band`. Feature code never writes `border-b px-* py-*`.
3. **Text aligns to the host's text edge.** Where a host's rows are padded pills (`Row`'s `p-row`, menu
   rows' `px-row`), the host publishes its *text rail* = rail + row pad (the cp-panel precedent: a
   two-part inset publishes the sum). Bands and labels align to it.
4. **An empty state declares no inline inset** — it inherits the region's, like any content.

## Before / after API

### 1. `OverlayPanel` / `PopoverContent`: a `footer` slot beside `header`

`header` exists (`overlay-panel.tsx:219`: `sticky rail-bleed my-overlay-header border-b …`, pulled into the
panel's block padding by `my-overlay-header`). Add `footer` (mirror, `border-t`, pinned bottom). Edge strips
stop being hand-rolled children of `padding="none"` popovers.

```tsx
// BEFORE  build-button.tsx:186 + build-popover-content.tsx:57-61
<PopoverContent width="3xl" padding="none">
  <Stack direction="row" className="border-b px-md py-sm"><Text variant="label">Builds</Text>…</Stack>
  …
// AFTER
<PopoverContent width="3xl" header={<Line><Fill><Text variant="label">Builds</Text></Fill>…</Line>}>
  …
```

### 2. `Band` — a rule in mid-content (new, in `css/plugins/column`)

```ts
interface BandProps { rule: "top" | "bottom" | "both"; children: ReactNode }
// = rail-bleed (cancel the rail) + re-apply the host's TEXT rail + py-sm + border-<rule>
```

- Bleeds the rule to the region edge, keeps its text on the host's text edge (principle 3).
- Not for a surface's first/last child — that is `header` / `footer` (a Band can't know it is first, and
  would double the panel's block padding).
- One block step (`py-sm`); no `pad` prop until a second value is proven.

**Text rail.** New var `--rail-text-start/end`, defaulting to `--rail-start/end`. Hosts whose rows are padded
pills set it to rail + `--pad-row-x`: `DropdownMenuContent`, `OverlayPanel` when it holds rows (opt-in prop
`rows`), `Column inset` (see 3), `cp-panel` (already computes the sum). Lives beside the other rail vars in
`app.css` and `rail/core`.

### 3. `Column` becomes an optional region owner

```ts
// css/plugins/column — added to ColumnBaseProps; typed exclusive with scrollBody={false}
inset?: SpaceStep;   // root rail-owe-<step>; header/body/footer wrappers rail-follow
rules?: boolean;     // border-b under header, border-t over footer
```

Exactly the app-shell sidebar topology (`rail-owe-sidebar` + `rail-follow`). `scrollBody={false}` +
`inset` is a type error (no Scroll to carry the follow — `pane-chrome.tsx:345` uses that form).

```tsx
// BEFORE  tag-sidebar.tsx:190-194
<Column fill className="w-72" header={<Stack gap="sm" className="p-sm">…</Stack>} body={…<TagPickerPanel/>…}/>
// AFTER
<Column fill inset="sm" className="w-72" header={<Stack gap="sm">…</Stack>} body={…<TagPickerPanel/>…}/>

// BEFORE  tag-picker-panel.tsx:155-223
<Stack className="p-sm"><SearchInput appearance="menu"/></Stack><Separator/>
<Stack className="p-2xs">{tree}</Stack><Separator/><Stack className="p-2xs"><FooterRow/></Stack>
// AFTER — the panel declares no inset; the host (popover or column) owns it
<SearchInput appearance="menu"/>
<Band rule="top">{tree}</Band>        {/* or: tree, then Band for the footer rule */}
{searching ? null : <Band rule="top"><FooterRow/></Band>}
// tag-picker-popover.tsx:41  padding="none" → padding="xs" (menu parity) — see decision D2
```

### 4. Pane body: extend the existing `PaneInset`, no new prop

`PaneChrome` already has `inset?: "chrome" | "content"` (`pane-chrome.tsx:82-103`, `--pane-inset`,
`contentInset` token). Add `"document"`: the content box inside the pane's `PaneScroll` pays and publishes
`rail-x` at `documentPadX` (existing token, lg), block `py-md`. Default stays `"chrome"` (unchanged).
DataView/DataTable panes stay `"chrome"` (their rows are `rail-follow`, `data-table.tsx:719`; a paying owner
would inset their full-bleed fills).

```tsx
// BEFORE  config_v2/settings panes.tsx:66 + config-detail.tsx:148
<PaneChrome pane={configDetailPane}><ConfigDetail/></PaneChrome>   //  <Stack gap="sm" className="p-md">
// AFTER
<PaneChrome pane={configDetailPane} inset="document"><ConfigDetail/></PaneChrome>  //  <Stack gap="sm">

// BEFORE  attempt-pane.tsx:226-233
<PaneChrome pane={attemptPane}><Inset pad="sm"> … <Text className="text-muted-foreground px-sm py-xs">No attempts.</Text>
// AFTER
<PaneChrome pane={attemptPane} inset="document"> … <Placeholder>No attempts.</Placeholder>
```

### 5. `Placeholder` declares only block padding

`px-md py-sm` → `py-sm` (`placeholder.tsx:12`). It inherits the region's inline edge like any content.
No `size` prop: centred block empty states already exist as `ResourceErrorInline variant="block"`
(`trace-detail.tsx:50` just drops its `p-2xl`).

### 6. Enforcement — narrow, high-signal, then broaden

Not a blanket ban on `p-*` in feature code (≈400 files would be exempt and blind; it would contradict
`no-adhoc-spacing`'s own message that points to `<Inset pad>`; it pushes people to wrapper-with-pad-prop,
the double-inset shape). Instead, three rules in `css/plugins/rail/lint/`, each naming its replacement:

| Rule | Flags | Says |
|---|---|---|
| `rail/no-unowned-overlay` | `padding="none"` on `PopoverContent`/`DropdownMenuContent` outside primitives | use a step + `header`/`footer`/`Band` |
| `rail/no-adhoc-band` | a class string with both `border-[tb]` (not `-transparent`/`-dashed`) and `p[xy]-*` | `Band`, or the surface's `header`/`footer` |
| `rail/no-pad-under-owner` | `p-*`/`px-*` on the root element a `Column inset`, `PaneChrome inset="document"` or `OverlayPanel` child renders (same-file only) | delete it — the host pays |

Existing violators get per-site `eslint-disable … -- debt: <task>` lines (the `no-adhoc-layout` precedent:
no globs), generated once. `no-adhoc-spacing`'s message is updated to point at region owners before `<Inset>`.
Type rung: `Column` `inset` × `scrollBody={false}` exclusive. Runtime: `useRailGuard` on `Column inset` and
`inset="document"` in dev. Gate: a `regionExhibit` per new owner (`Column inset`, `Band`, document pane body).

## What gets fixed (slices, each its own PR + screenshots)

| Slice | Change | Sites fixed | Representatives |
|---|---|---|---|
| **1** | `footer` slot, text rail, `Band`, `Column inset/rules`, the 3 lint rules (with debt disables) | tag picker (both hosts), the 10 feature `padding="none"` popovers, ≈115 hand-rolled bands (incl. ~10% false positives to drop), 26 `Column` users opt in where they pad their regions | `tag-picker-*.tsx`, `tag-sidebar.tsx`, `build-button.tsx`+`build-popover-content.tsx` (duplicated header), `notifications-panel.tsx` (5 hand-picked insets) + `bell-button.tsx:148`, `recovery-view.tsx:136`, `profiling/gantt-view.tsx:27`, `profiling/shared.tsx:229`, `config_v2 invalid-diff.tsx:51`/`conflict-diff.tsx:49`, `places page-overlay-panel.tsx:206` |
| **2** | `PaneInset "document"`; migrate document panes one at a time | ≈100 of the 183 region-inset uses (pane bodies; the rest are cards/legit) | `config-detail.tsx:148`, `report-detail.tsx:74`, `read-set-view.tsx:183`, `attempt-pane.tsx:233`, `memory-panel.tsx:191`, `plugin-detail.tsx:39` |
| **3** | `Placeholder` block-only; empty-state text onto `Placeholder` / `ResourceErrorInline` | 69 text-block sites + the 165 `Placeholder` uses re-seated | `notifications-panel.tsx:297,374`, `attempt-pane.tsx:90,232`, `page-options.tsx:113`, 12 `Center p-2xl` |
| **4** | Broaden the lint once slices 1-3 shrank the debt; `Card` → `rail-card`; retire or re-mean `Inset` | the rest, each gated by screenshots | `stats-panel.tsx:44` (`Surface p-lg` → `Card`), KPI tiles `cost-kpis.tsx:106` |
| out of scope | items/controls (236: mostly `Row`/`Button` adoption), table cells (63 in one file → `DataTable`), vertical rhythm (163, mostly legit reading-column `pt/pb`), indent (40) | filed as tasks, not this plan | |

Dropped from the first design after review: a required `PaneChrome.body` prop + "flush everywhere" codemod
(duplicated `PaneInset`, carried no information); `Inset` → `rail-*` in one step (owed=0 silently stops every
follower under 112 Insets paying — 50 of those files render `Loading`/`DataView`); `Placeholder` →
`rail-follow` (nested followers double-pay; drift with density); Sheet rework (2 users, would newly inset flush
bodies); `Band pad` prop; `Placeholder size`.

## What changes visually

Ramp: 2xs 2 · xs 4 · xsm 6 · sm 8 · smd 10 · md 12 · lg 16 · xl 24 · 2xl 32 px (`density/core/group.ts`).

**Intended normalisations**

- **Tag picker**: search, tree and footer share one edge. Popover: tree pills move from 2px to the menu rail
  (4px with `xs`, 8px with `sm` — D2). Places sidebar: whole panel moves onto the column's `sm` rail (8px),
  aligned with the presets list above it (today header `p-sm`, body flush).
- **Hand-rolled bands** (`px-lg` ×33, `px-md` ×22, `px-sm` ×8 today): text moves to the host's text edge —
  one value per host instead of three. Block padding becomes `py-sm` everywhere: today's `py-xs` bands (20)
  grow 4px total, `py-md` bands (8) shrink 8px total.
- **Notifications popover**: `padding="none"` → `xs`; its strips and rows share the text rail (today
  `px-md` strips align with `pl-md` rows by luck; after, by construction — same 12px edge if rail 4 + row 8).
- **Document panes**: today `sm`/`md`/`lg` (8/12/16) → one `documentPadX` (lg, 16). `p-md` panes
  (config-detail, report-detail) gain 4px; attempt-pane goes from 16 (Inset sm + `px-sm`) to 16 (same edge,
  one owner).
- **Placeholder**: loses its own 12px inline inset; its text lands on the region's edge, aligned with the
  rows/labels around it. In a region-less spot it becomes flush — the lint/exhibits must surface those (slice 3
  migrates them into an owner first).
- **Empty states**: `Center p-2xl` around centred text → no padding (text is centred; no visible change
  except on very narrow panes).

**Risks — screenshot before/after**

- Every host of `Band`: if a host forgets to publish its text rail, band text sits 8px left of row text.
- `Column inset` on columns whose regions already pad (26 users): double inset until their `p-*` is deleted —
  the `no-pad-under-owner` lint catches same-file cases only.
- Popovers switched from `none` to a step lose width for content (fixed `picker` width loses 8-16px).
- `Separator`s inside newly padded popovers stop being full-bleed until they become `Band`s.
- DataView panes accidentally given `inset="document"` (rows lose full-bleed fills).

## Verification

- `regionExhibit` for `Column inset`, `Band` (in popover / menu / column / section card), document pane body;
  `./equin check layout-geometry`.
- Per slice, before/after `screenshot.ts` at 1280×900 on: `/places` (sidebar), a prototype's tag chip popover,
  the build popover, the notifications bell popover, `/debug` reports / read-set / trace / profiling,
  Settings → Config detail, a task attempt pane. Compare with the compare-diff sheet where helpful.
- `useRailGuard` console output stays at zero in dev on those routes.
- `./equin check` (new lint rules + existing) and `./equin test plugins/primitives/plugins/css`.

### Visual review deliverable (required per slice)

The user reviews every slice through **before / after screenshots in a slider prototype**, not prose.

1. **Before** — on this worktree's build, *before* any slice edit, capture each affected surface with
   `screenshot.ts` (1280×900, light, fixed `--wait`), opening popovers with `--click`
   (e.g. `--path /places`; a prototype's tag chip; the toolbar Build button; the notifications bell).
   One PNG per surface, named `<surface>-before.png`, into `$EQUIN_SCRATCH/inset-review/`.
2. **After** — rebuild with the slice, re-run the identical commands → `<surface>-after.png`. Same DB, same
   viewport, same state, so the only diff is the change.
3. **Prototype** — `./equin prototype new "Inset slice 1 — before / after"`; copy the PNG pairs into its flat
   folder; `index.html` shows one surface at a time as the two images stacked with a draggable vertical
   divider (before left, after right; pointer + keyboard). The surface is a declared option
   (`<meta name="prototype-option" content="surface: tag-popover | places-sidebar | build-popover | notifications | …">`),
   never an in-page switcher; no instruction copy. No `mocks` meta (it is a review artifact, not a redesign).
4. Write the `proto-…` id in the report; the user approves from it before push.

Slice-1 surfaces: tag picker popover (a prototype's tag chip), Places sidebar, build popover, notifications
popover, every other feature `padding="none"` popover, and one host per migrated band recipe (recovery view,
profiling gantt + footer, config diff header, places page overlay panel).

## Decisions (answered 2026-11-09)

- **D1** Text rail: **hosts publish `--rail-text-*`** (default = rail; row hosts publish rail + `--pad-row-x`).
- **D2** Tag-picker popover: **`xs`** (4px, dropdown-menu parity).
- **D3** Document pane inset: **`documentPadX`, lg 16px**.
- **D4** **Slice 1 ships alone first**; slices 2-3 after its screenshots are approved.

## Slice 1 — as implemented (2026-11-09)

Where the implementation diverged from the design above, and why:

- **Text rail mechanism.** Every rail class publishes `--rail-text-start/end` =
  rail + `--rail-row-pad`; `--rail-row-pad` is a registered NON-INHERITED
  property (`@property`, initial 0px) that a row host sets on itself with
  `rail-rows`. A nested region therefore resets the text rail by construction —
  no specificity or source-order contest between `rail-rows` and the rail class
  on the same element. `cp-panel` sets its text rail to its rail (it already
  publishes the sum).
- **`Column inset` regions OWN, they do not follow.** The design said the
  sidebar topology (`rail-owe` root + `rail-follow` regions). That makes every
  follower inside the body (a DataView's bands, a `Loading` skeleton) pay a
  second time — the nested-followers trap. Each region (header, body scroller,
  footer) is instead `rail-x-<step>` + `rail-rows` + `py-<step>`: the scroller
  still spans the column edge, followers inside pay nothing. No `useRailGuard`
  on it yet.
- **`Band` = `rail-band py-sm border-*` (content in a `rail-band-region`).** `rail-band` is `rail-bleed` with the
  TEXT rail re-applied; outside any region it pads by the `rail-follow` floor
  (pane inset, else chrome pad) and bleeds by nothing. The overlay panel's
  `header` (and new `footer`) wear it too, so a menu's header text moved onto
  its rows' text edge (rail + row pad).
- **`no-adhoc-band` exempts `rail-band` / `rail-bleed` / `rail-follow` strips**:
  their inline inset is the rail's, not hand-picked (the version-history
  header, command palette, select header were false positives).
- **`no-pad-under-owner` covers `Column inset` and padded overlay panels only**;
  `PaneChrome inset="document"` joins it in slice 2.
- **Tag picker separators** are `<Separator bleed />` (new: a plain rule that
  `rail-bleed`s to the region edge — the plain rule's `data-horizontal:w-full`
  out-specified `rail-bleed`'s width, so `className={MENU_SEPARATOR}` on a
  `Separator` stopped one rail short), not `Band`s: a Band around the tree
  would indent its rows by the text rail.
- **Notifications rows keep `pl-md`**: the unread dot hangs in the row's
  leading padding, so the row cannot shrink to `px-row` without clipping it.
  Header title and section labels sit on the text rail (12px, as before).
- **Self-contained surfaces keep `padding="none"`** behind sanctioned
  disables (control panel `cp-*`, colour picker, folder picker, shelf peek,
  raw-JSON code block). Debt (`-- debt (task-1794239361-kagy27)`): ~68 bands,
  the reorder editor's Add popover and the data-view search suggestions.
- **Exhibits**: `column/inset-region` (region kit in the body) and
  `column/band` (row host vs plain region).

### Round 2 (review of proto-1794240616-2h8ifv)

- **Rule: never migrate a band before its host owns the inset.** A `Band` lands
  on the host's (text) rail; in a pane that still hand-pads its sections it
  lands on the pane floor instead, a few px off the content (profiling's
  Refresh and footer moved 4px off the sections' 16px). So every band whose
  host does not own its inset yet stays a debt disable: profiling, recovery and
  the config diffs point at slice 2 (task-1794237886-rfwccn, document panes);
  the Places page-overlay panel and the build popover at
  task-1794239361-kagy27. Slice 1 ships `Band` with no feature consumer yet —
  only the overlay panels' own header/footer strips use its mechanics.
- **Overlay header/footer strips are `py-sm`** (were `py-xs`): the strip bleeds
  up through the panel's block padding, so its own padding IS the room above
  its title; `xs` left a title nearly touching the panel edge.
- **The menu search field owns its room** (`menu-field`): on a narrow rail it
  tops its inline and top inset up to `sm` from the region edge
  (`max(0, sm − rail)`), and keeps `sm` above a rule right under it. Rows may
  sit on a 4px rail because their pill is invisible at rest; a bordered field
  is always drawn. Applies to every `SearchInput appearance="menu"` host.
- **`rail-band-region`**: a band's content box republishes the band's padding
  as the rail, so a child can `rail-bleed` to the region edge out of it (the
  notifications chip strips scroll edge to edge again).

### Round 3 (independent review of the six comparisons)

- **Places presets → search gap** had grown 16 → 24px. The extra 8px was the
  menu search's top room on a region that publishes no block rail (fixed in
  round 2: no published rail, no room), not the column's block padding — an
  intermediate "no block padding where regions meet" rule over-corrected it to
  8px and was reverted; each region keeps its step, 16px as before.
- **`<Separator bleed>` carries `my-menu-separator`** (a menu hairline's `xs`
  room on both sides), and the menu search keeps `xs` above a rule: search →
  rule stays 8px, and a hovered first/last row no longer touches the rule.

### Round 4 (full-surface comparison, hint-free captures)

- Captures answer onboarding tips through the hints engine's own e2e helper
  (`answerTipsAsTheyShow`) and refuse to shoot while any hints-stage piece is
  up; page-backed surfaces open on blank pages created through the app in the
  worktree's DB and deleted after the run.
- The menu search's room leaves control-panel hosts alone (the field-search
  list, hosted options, the dependency "+ Add" search stay at 4px): they bleed
  their rows instead (`.cp-panel &`).

## Slice 2 — as implemented (2026-11-12)

- **`PaneInset "document"`** (`pane-chrome.tsx`): a box inside the body's
  `PaneScroll` wears `rail-document` (a new `@utility` beside `rail-panel`:
  publishes and pays the rail at `--document-pad-x`, block
  `--document-pad-top` / `--document-pad-bottom` — the density group's existing
  document tokens, the Markdown view's margins). Inside the scroller, never on
  it: a sticky offset counts from the scroller's padding edge, so a padded
  scroller pinned a table's header and first column a rail in (the first cut
  did; review caught the first column's text 16px off). The box is a one-row
  grid at least as tall as the scroller, so a child's `h-full` still resolves.
  No new prop, no new token.
- **The header stands on the same edge**: `px-chrome-pane` /
  `pr-floating-bar-pane` read `--pane-header-pad-*` first, which
  `pane-header-document` (on a document pane's header element only, so a
  nested pane keeps its own) points at `--document-pad-x`; a leading icon
  control hangs into it by the `sm` icon button's inset, so its glyph is on
  the edge. Before, the title
  stayed at the chrome pad (12px) while the body moved to 16px — a 4px jog.
- **Tables keep their gutter** (data-table "Row inset"): in a region that
  paid its rail a `rail-follow` row owes 0, so rows sat flush on the rail with
  no room for their fills. A grid / outline table's box now cancels what its
  region paid (negative margin, rail − owed) and its grid hands it back as
  owed: rows and rules full-bleed, cell text on the rail. In the grid look
  the grid pads by the bleed and each row takes the matching negative margin,
  so the bleed never comes out of the edge tracks (a first cut paid the rail
  on the rows alone: Studio's fixed `#` column lost 16px, wrapped its label
  and grew the header 28 → 44px). A bleeding table's last row draws no rule. Zero change where
  nothing was paid (owe regions, plain panes). This also applies to tables in
  `detail-sections` card bodies (`rail-lg`), which had the same flush rows.
- **`rail/no-pad-under-owner`** covers `PaneChrome inset="document"`'s direct
  children (same file).
- **Migrated** (17 panes; each lost its own `p-*` / `<Inset>` and, where it
  had one, the redundant inner `Scroll`): config detail, report detail,
  read-set, queue job / dead / emission / trigger detail, Claude CLI call
  detail, health monitor, heap, tab memory, live-state health, live-state
  emit, op detail, Studio compare, mail message reader, conversation summary,
  workflow node, server create form. Every arm of a migrated pane (loading,
  error, empty) shares the region, so a pane no longer jumps between states.
- **Left for a per-pane decision** (task-1794490549-cbyqt4): reading columns
  (`mx-auto max-w-*` + `px-xl/2xl` — a document region would add to a
  centred column), `xl` bodies, padded-pill row lists (attempt pane, agents
  root, compositions list — DataView candidates, not documents), bodies
  holding a DataView, split / tool-shaped panes (memory, profiling, recovery,
  render profiler), and branch-only paddings. The profiling and recovery band
  debts moved to that task; the config diffs' band is a bordered box's header,
  not the pane's, so its debt moved to the card follow-up (task-1794239361-kagy27).
- The review prototype is a slider per migrated pane (light/dark as the
  worktree renders, 1280×900).
