# DataView pixel-perfect pass — structure in DataView, sizes in the app themes

## Context

The previous pass (`research/2026-10-22-global-data-view-default-redesign.md`) shipped the new DataView
look, but `/sonata` and `/prototypes` still do not match their mockups (Sonata
proto-1792667077-4bakda, Prototypes proto-1792667078-9zh04x). Measured at 1440×900 (Sonata):

| Part | App | Mock |
|---|---|---|
| Header | pane header row + separate toolbar row, title at 12px inset | pane header (48px, no rule) whose title, toolbar and grid share ONE inset |
| Toolbar pills | 34px, items 28px, every view labelled, tinted active | 40px, items 32px, inactive views icon-only, active labelled + inverted fill, labelled accent "Add" |
| Content inset | 12px, no max width → 6 columns | `clamp(16px,3vw,40px)`, 1520 max → 5 columns |
| Card text | title 11.5/500, subtitle 11, 8px gap | title 13.5/600, subtitle 12, 10px gap, fixed 18/17/18 lines |
| Group header | muted label, no icon | 26px icon chip tinted per source, 15/700 label, 14px below |
| "All" view | flex rows, fields wander, no header | aligned columns + one uppercase header row — a table |

Root causes: DataView parts hard-code generic type roles and spacing (a theme can only change them
app-wide, never per part); no inset / max-width / toolbar tokens; the list was used where the mock
draws a table; group sections carry no identity (icon/colour).

**Approved principles**

- **Split structure from size.** New mechanisms land in DataView / pane / table / fields for every
  surface, but every new token's DEFAULT reproduces today's look — the ~65 other DataView surfaces stay
  pixel-identical. Only the Sonata and Prototypes themes set mock values. Changing defaults app-wide is
  a separate follow-up.
- **Keep the closed type ladder.** Per-part *role pickers* (precedent: `overlay` `tooltipRole` +
  style-query classes in ui-kit `tooltip.tsx`, checked by type-scale rule 6): each part picks a rung
  (role or 2xs/3xs), a weight (normal/medium/semibold/bold — the shared weight tokens) and a family
  (sans/mono). No free sizes; `--font-scale` still scales everything.
- **Mockups stay unconstrained** — no conventions or attributes in them. Real components carry
  `data-part`; a mapping file kept with the app maps mock selectors → parts.
- **Header: split** for both apps (pane header above the toolbar, same inset, no rule). The merged
  mode (title inside the toolbar) is NOT built in this pass.
- **Sonata's list-shaped views become tables** (All, Longest, Recent); Prototypes' "Recently edited"
  too. No other saved-view setting changes (grouping, sort, filters stay as the user has them).
- Group labels keep the existing source labels ("MIDI File").
- Option colours are a **typed reference to a declared colour token** (tsc rejects unknown names).

## Design

### 1. Role picker (text plugin + type-scale check)

- `plugins/primitives/plugins/css/plugins/text/core/roles.ts`: `PICK_RUNGS` (roles + subscale),
  `PICK_EMPHASES` (`role|normal|medium|semibold|bold`), `PICK_FAMILIES` (`role|sans|mono`),
  `type RolePart = { role; emphasis; family; fallback }` (CSS var names + fallback rung).
- New `text/web/internal/role-pick.ts`: ONE literal Tailwind table per axis keyed by generic vars
  `--role-pick` / `--role-emphasis` / `--role-family`
  (`[@container_style(--role-pick:label)]:text-label`, …, plus `-compact` forms so `textStepFor`
  keeps working in `DataTable`). `Record<…, string>` typed so it covers the vocabulary.
- `Text` gains `pick?: RolePart` (union-exclusive with `variant`): a `display: contents` wrapper sets
  the three generic vars from the part's tokens; the inner element carries the fallback class + tables.
  **Spike first** that Chromium evaluates container style queries against a `contents` ancestor;
  fallback: `rolePickScope(part)` style spread on the part's existing wrapper.
- `plugins/ui/plugins/tokens/plugins/type-scale/check/index.ts`: rule 6 becomes a registry
  `ROLE_PICKERS = [tooltip, role-pick]`; new rule 6b: every token key ending `Role|Emphasis|Family`
  declares `values` equal to the matching `PICK_*` list. Token names never contain `weight`/`size`
  (rule 2 regex).
- `plugins/ui/plugins/theme-engine/core/define-token-group.ts`: `TokenGroupField.values?` narrows the
  fragment type (a bad role in a theme is a tsc error); `default: "initial"` documented as "unset —
  the consumer's fallback applies" (paint test). Customizer `TokenRows` renders a select for
  enumerated keys.

### 2. Token group `ui/tokens/data-view` (new; defaults = today)

`plugins/ui/plugins/tokens/plugins/data-view/` (pattern: `overlay`, `sidebar-metrics`). Parts with
`<part>Role/Emphasis/Family`: `viewChip, search, create, cardTitle, cardSubtitle, cardToken,
cardTokenNumeric, groupLabel, groupCount, columnHeader, titleCell, titleCellSubtitle, cell` — defaults
equal today's spellings (e.g. cardTitle `label`, cardSubtitle `caption`, cardTokenNumeric `code`,
columnHeader `3xs`/medium, groupLabel `group`). Plus:

- **Inks**: card subtitle/token/token-icon, group count, column header (+ sorted), view-chip active
  fill/ink/ring, cover ring.
- **Toolbar**: `toolbarPadY`, `toolbarGap`, `toolbarSpaceBelow`, `pillPadX/Y`, `pillGap`,
  `pillDividerH/PadX`, `searchWidth`, `searchWidthNarrow` (initial).
- **View chip**: `viewChipIcon always|never`, `viewChipLabel always|active`, active pad start/end,
  `viewAddSeparator show|hide`; narrow: `narrowCreateLabel show|hide`.
- **Card**: `cardMetaPadTop`, `cardTitleLine/SubtitleLine/TokensLine` (1lh), `cardSubtitleGap`,
  `cardTokensGap`, `cardSubtitleLines` (1), `cardTokenGap`, `cardTokenIconSize`.
- **Cover**: `coverLift`, `coverZoom`, `coverHoverFilter`, primary size/inset, action-chip inset.
- **Groups**: header gap/padY/space-below, group gap, chevron size, chip size/radius/fill/icon size.
- **Soft table** (new presentation, touches nothing existing): row h/pad/radius/col-gap/hover fill,
  rule ink/opacity/start, header h/space-below, frame fill/border/shadow/radius/pad, thumb w/h/radius,
  `softThumbNarrowW`, `columnHeaderCase upper|none`, `columnHeaderTracking`, `sortIcon always|sorted`.

`density` gains `contentInset` (default `initial`). `app.css` gets one `@utility` per consumed token
(twmerge markers), `rail-follow` gains the floor
`var(--rail-owed-start, var(--rail-start, var(--pane-inset, var(--chrome-pad-x))))`, and a
`px-pane-inset` utility; `data-table.tsx` `RAIL_START/END` (≈:139) take the same floor.

### 3. Pane: shared inset (split header)

`plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`: `inset?: "chrome" | "content"`
(default `chrome`). `content` makes the pane root `container-type: inline-size`, sets
`--pane-inset: var(--content-inset)` (invalid when the theme leaves it `initial` → today's
fallback), and gives the header `Bar` `px-pane-inset`. So header title, toolbar and content share one
pane-relative edge (`cqi`, not `vw`). Header height/rule come from the existing `chromePaneH` /
`chromePaneRule`; verify Sonata's player header (drawn by `PlayerHeader`, not the pane bar) is not
affected, else add a pane-scoped override. `data-part` `pane.header` / `pane.title`.

### 4. Toolbar, view switcher, create

`data-view/web/components/toolbar/{pills-toolbar,data-view-toolbar,bar-arrangement}.tsx`,
`creators-control.tsx`, `data-view/plugins/view-core/web/components/editable-view-switcher.tsx`:
hard-coded `p-2xs`, `gap-2xs`, `gap-sm`, `py-sm`, `h-5` → tokens; `spaceBelow` → token. Switcher keeps
`ToggleChip variant="ghost"`, adds token-driven active fill/ink/ring/padding and the label/icon
policy via style queries; label typography via `pick`. **N creators + labelled form**: a labelled
`Button` ("Add", new `DataViewProps.createLabel`) triggering the creators menu (today N creators
always collapse to "+"). Narrow stage: the band is a `@container`, `NARROW_BREAKPOINT = 760` beside
`COMPACT_BREAKPOINT`, gated by `narrowCreateLabel` / `searchWidthNarrow` (no-ops by default).

### 5. Gallery card and cover

`card-meta.tsx`, `cover-frame.tsx`, `gallery/web/components/data-card.tsx`: `Text pick` per line;
line boxes/gaps/token gap/icon size+ink from tokens; `Stack gap="sm"` → `cardMetaPadTop`; Pin offsets
and primary size from cover tokens; ring/lift/zoom/filter tokens (reduced-motion guard). Subtitle clamp
when `cardSubtitleLines > 1` (Prototypes: 2-line blurb, fixed height). Each token `FieldCell` gets
`context="token"`.

### 6. Group headers: identity data path

`FieldOption` gains `icon?: IconRef`, `tint?: ColorTokenRef` (typed union of declared colour token
vars, generated from the token groups) → `GroupBucket` gains the same → enum grouping
(`plugins/fields/plugins/enum/plugins/data-view-group/core/internal/enum-groupings.ts`) copies the
matched option's → `DataViewSection.identity` (`use-data-view-sections.ts`) →
`DataViewGroupHeader` (`web/internal/group-header.tsx`) draws the chip before the label only when
`identity.icon` exists (no existing surface has one). Label/count via `pick`; spacing, chevron from
tokens (`section-header-row.tsx` only gains token hooks). Enum read cell: `tint` without `variant`
draws a 7px dot + label (the mock's source cell/token).

### 7. Soft table: cover column, title cell, primary

`plugins/primitives/plugins/data-table/web/internal/{data-table,types}.ts(x)`,
`data-view/plugins/table/web/components/{table-view,nested-table-view}.tsx`:

- `presentation: "grid" | "outline" | "soft"` — new `ROW_LOOK` entry: min row height, radius, col
  gap, hover fill, no border, between-row hairline from `softRuleStart` hidden around the hovered
  row; header row height/space-below; header text via `pick` + case/tracking/ink (grid defaults
  reproduce today's `HEADER_TEXT_CLASS`); `sortIcon: sorted` hides unsorted arrows; optional frame;
  `ROW_ESTIMATE` from the soft row height so virtualization holds. The header is already rendered
  once and shares tracks across groups.
- `TableViewOptions.cover?: boolean` — leading `CoverFrame size="thumb"` column from `resolveCover`
  (`web/internal/cover.ts`), soft thumb tokens.
- `titleCell?: "plain" | "stacked"` — `partitionCardFields` (`web/internal/card-fields.ts`) over the
  visible fields: title + indicators (line 1) + subtitle run of text fields (line 2); the remaining
  token fields are the value columns (width/align from FieldPresentation; `dropOrder` drops them under
  640px container width).
- Primary: `hasPrimarySlot: options.cover === true` (table-view.tsx:80) → Play over the thumbnail on
  hover (and in the trailing hover cluster, as the mock); otherwise demotes as today.
- Extract the list's subtitle composition (`list-view.tsx` ≈657–760) and `PrimaryOverThumbnail`
  (≈909) into `data-view/web/internal/subtitle-run.tsx` / shared component; the list re-imports them
  with identical output (test pins it).

### 8. Cell vs token field rendering

`plugins/network/plugins/live/web/internal/field-presentation.ts`: `FieldPresentationSpec.token?`
beside `cell`, minted into `FieldDef.token` (+ `FieldOverride.token`). `FieldCell context="token"`
resolves `field.token → field.cell → type cell`; `cell` context unchanged. Opt-in `extent: true`
gives `cell(value, row, { extent: {min,max} })` computed once per view over its rows (plays bar).

### 9. Metrics diff on the existing compare tool

`plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts` + new `part-metrics.ts`:
`--metrics <file.parts.json>`, `--metrics-tolerance px=0.5,de=3,weight=0`, `--metrics-only`,
`--fail-on-metrics`; `--width` accepts any px (preset if it matches, else Responsive +
`sizeWindowTo`) so 700 works. After `settle`/picks, before `capture`: one `evaluate` per frame
(mock iframe, counterpart iframe) measuring box (frame-relative), padding, gaps, font
size/weight/line-height/family/tracking/case, radius, border, colours (ΔE via the existing colour
helper), shadow, opacity; optional `hover`. Prints part · prop · mock · app · Δ · ok and writes
`-metrics.json`. Unknown part names fail. Parts vocabulary: closed `DATA_VIEW_PARTS` in
`data-view/core/internal/parts.ts` (+ `dataPart()`); pane spells its two literally.

Mapping files (mock untouched), e.g.
`plugins/apps/plugins/sonata/plugins/library/e2e/proto-1792667077-4bakda.parts.json`:

```json
{ "proto": "proto-1792667077-4bakda",
  "parts": [
    { "part": "dv.views-pill", "mock": ".views" },
    { "part": "dv.card-title", "mock": ".card .meta .t b", "nth": 0 },
    { "part": "dv.cover", "mock": ".card .cover", "nth": 0, "hover": true, "hoverTarget": ".card" },
    { "part": "dv.column-header", "mock": ".lhead > div:nth-child(2)", "when": { "layout": "list" } },
    { "part": "pane.header", "mock": ".phead", "when": { "header": "split" } } ] }
```

### 10. Apps

**Sonata** — `sonata/plugins/shell/web/internal/theme.ts`, `library/web/{panes.tsx,
internal/presentation.tsx, components/song-library.tsx}`, `config/apps/sonata/library/sonata.library.jsonc`,
playback-history presentation, source contributions:

- `PaneChrome … inset="content"`; theme `chromePaneH` 3rem, `chromePaneRule` 0.
- Source options carry `icon` (already on `SonataDocument.Source`) + `tint` (new on the
  contribution, a colour-token ref); `song-cover.tsx` uses the declared tint.
- `playCount`: cell = number + 40×3 bar (`extent`), token = `N×`; `duration` cell in foreground ink.
- All / Longest / Recent: `type: "table"`, `presentation: "soft"`, `cover: true`,
  `titleCell: "stacked"`; everything else (sort, grouping, properties, filters) unchanged. Remove the
  duplicate `"icon"` keys.
- Theme values from the mock: `contentInset max(clamp(16px,3cqi,40px), calc((100cqi - 1520px)/2))`;
  toolbar padY 12 / gap 10 / space-below 16; pills pad 3, gap 2, divider 18; search 220 (narrow 140);
  `controlHeightSm` 2rem; view chip label `active`, active fill `var(--foreground)` ink #101014, pad
  11/13, add separator; card meta 10, lines 18/17/18, gaps 2/5, token gap 12, icon 12 faint; cover lift
  3, zoom 1.035, hover filter, primary 38 @10, chip inset 8; groups gap 10, padY 4, below 14, group gap
  26, chevron 16, chip 26/r8/icon 15; soft table row 56, pad 8, col gap 14, radius 14, rule from 74 @.6,
  header 30 (+4), thumb 52×34 r9, header tracking .12em, sorted ink foreground, `sortIcon sorted`.
  Picks: viewChip body/semibold, create control/bold, cardTitle heading (13.5/600), cardSubtitle
  tag/normal/sans, cardTokenNumeric 2xs/medium/mono, groupLabel group/bold (15/700), groupCount
  caption/medium/mono, columnHeader 3xs/bold, titleCell body/semibold, cell code/medium. Type-scale
  values: group 0.9375rem/700, heading 0.84375rem/1.125rem, code 0.75rem, tag 0.75rem/1.0625rem.
- Mapping file + a short `e2e/README` line in the plugin CLAUDE.md.

**Prototypes** — `prototypes/plugins/shell/web/internal/theme.ts`,
`gallery/web/{panes.tsx, components/prototype-gallery.tsx, internal/gallery-fields.tsx}`,
`config/apps/prototypes/gallery/prototypes.gallery.jsonc`:

- `PaneChrome ground={<CanvasGround/>} inset="content"` (split header).
- "Recently edited": `type: "table"`, soft, cover, stacked title; other settings unchanged.
- Field tokens: `modifiedAt` "Nd ago", `versions` "vN".
- Theme values from its mock: `contentInset max(clamp(16px,4cqi,56px), calc((100cqi - 1560px)/2))`;
  pills 42px pad 5 gap 1, items 30px; view chip icon `never`, active fill white 7% + ring; card meta
  11, title line 19, 2-line blurb (12.5/1.45), tokens line 17 gap 7, token ink faint; group header
  13/500, below 16, group gap 28, chevron 14, no chip; soft table in a float frame (r14, pad 4), rows
  pad 7/8 r10, col gap 16, rule from 108, thumb 84×52.5 r7 (narrow 72), header case none, 11px faint,
  `sortIcon sorted`.
- **Update the Prototypes mock** (proto-1792667078-9zh04x) with the same `header: merged | split`
  option as Sonata's (split = a 48px pane header with title, no rule) and one shared `--inset` for
  header, toolbar and content, so compare runs against the real app's layout.

### 11. Exhibits (regression) and docs

`plugins/primitives/plugins/data-view/exhibits/index.ts` with committed configs under
`config/primitives/data-view/`, static fixtures with option icons/tints and covers:
`data-view/toolbar`, `data-view/gallery-card`, `data-view/group-headers`, `data-view/table-soft`,
`data-view/table-grid` (today's look). Docs: data-view, table, data-table, pane (`inset`), rail
(`--pane-inset` floor), type-scale (picker registry), tokens/data-view, Sonata library, Prototypes
gallery, compare (`--metrics`).

## Phases and file ownership

```
P0 contracts (serial, one agent)
  ├─► P1a pane ∥ P1b toolbar ∥ P1c card ∥ P1d groups ∥ P1e table ∥ P1f field token API ∥ P1g metrics diff
  └─► P2a Sonata ∥ P2b Prototypes (+ Prototypes mock update)   — after P1a–P1f
        └─► P3 exhibits + docs + verification
```

- **P0**: `define-token-group.ts` (+paint test, customizer select), text `core/roles.ts`,
  `web/internal/role-pick.ts`, `text.tsx`, type-scale check, new `ui/tokens/data-view` group,
  `density` `contentInset`, `app.css` utilities + rail floor, `data-table` RAIL floor,
  data-view core (`parts.ts`, `FieldOption`/`GroupBucket`/`DataViewSection`/`FieldDef.token`/
  `createLabel`, `ColorTokenRef`), `TableViewOptions` types, `FieldCell context`.
- **P1a** §3 · **P1b** §4 · **P1c** §5 · **P1d** §6 · **P1e** §7 · **P1f** §8 · **P1g** §9 —
  disjoint files as listed in each section.
- **P2a / P2b** §10 · **P3** §11.

## Verification

1. `./equin check` — notably `type-scale:closed-role-ladder` (rules 6/6b), `type-check`,
   `eslint`, `plugins-doc-in-sync`, `data-views-in-sync`.
2. `./equin test` on data-view, data-table, css/text, css/row, theme-engine, ui/tokens,
   fields/enum, network/live, pane, sonata/library, prototypes/gallery. New tests: picker tables cover
   `PICK_*`; enumerated fragment typing; `FieldCell` token precedence; soft row look; list subtitle
   output unchanged after extraction; enum identity reaches the section.
3. Container-query audit before P1a ships: unnamed `@container` / `@sm:`-style queries that a newly
   containered pane could capture (viewer-grid, scroll, icons-view, capsule-toolbar, label-lane,
   home-layout, welcome-view, chord-*). Only `inset="content"` panes become containers.
4. `./equin build` (background), then compare for both apps, `header=split`, `layout=gallery`
   and `layout=list`, at `--width 1440` and `--width 700`, with `--metrics <mapping>`; gate on the
   metrics table, then pixel/colour. Known residuals: user-data titles (underscores, URLs), the
   mock's "fresh" dot / link button, Prototypes' "New prototype" launch popover typography, sample
   data differences.
5. `exhibit-shot.ts --id data-view/{toolbar,gallery-card,group-headers,table-soft,table-grid}` under
   `--theme chrome|sonata|prototypes`.
6. Unchanged surfaces (zero diff expected, `screenshot.ts` before/after at 1280×900): agent-manager
   task list and conversation sidebar, Settings → Accounts, a Debug grid table, Places, theme
   gallery, file explorer (outline table), Pages sidebar; `data-view/e2e/live-pages-scroll.ts
   --view table|gallery`.

## Follow-ups (not this pass)

- Make the mock values the DataView defaults app-wide (the tokens above, one theme-default change).
- Merged header mode (pane hands title + leading control to the DataView toolbar).
- Song-title cleanup (user data).
