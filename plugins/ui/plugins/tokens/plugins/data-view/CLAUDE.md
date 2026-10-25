# data-view (token group)

How a DataView looks, part by part — the type each part picks, its inks, and
the metrics of the toolbar, view chips, gallery card and cover, group headers
and the `soft` table. **Every default is the look the part had before this
group existed**, so a theme that leaves it out changes nothing: every DataView
surface stays pixel-identical. An app theme that wants a different DataView
(Sonata, Prototypes) sets values in a `dataViewGroup.fragment(…)`.

A default of `initial` is UNSET: the var is the guaranteed-invalid value, so the
consumer's `var(--x, <today>)` fallback applies (`searchWidthNarrow`,
`coverPrimarySize`, `viewChipActivePadStart/End`, `softThumbNarrowW`).

## Type is picked, never sized

Each part has three enumerated tokens — `<part>Role` (a rung of the closed
ladder, or 2xs / 3xs: `PICK_RUNGS`), `<part>Emphasis` (`role` = the rung's own
weight, a shared weight, or `parent` = the weight of the control it sits in:
`PICK_EMPHASES`) and `<part>Family` (`role` / `sans` / `mono`:
`PICK_FAMILIES`). The type-scale group still owns every metric, `--font-scale`
still scales them, and the type-scale check (rule 6b) holds each `values` list
to the vocabulary. A component reads a part through its `RolePart`:

```tsx
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
<Text pick={DATA_VIEW_PICKS.cardTitle}>{title}</Text>
// an element <Text> cannot be: rolePickScope(part) on its parent, rolePickClass(part.fallback) on it
```

Parts (default rung / emphasis): `viewChip` caption / parent · `search` caption ·
`create` control · `cardTitle` label · `cardSubtitle` caption · `cardToken`
caption · `cardTokenNumeric` code · `groupLabel` group · `groupCount` code ·
`columnHeader` 3xs / medium · `titleCell` caption · `titleCellSubtitle` caption
· `cell` caption (families all `role`). Inside a compact (`xs`) region a pick
steps to its rung's compact form like `<Text variant>` — a grid table cell's
consumer must account for that.

## Tokens and the utilities that read them

- **Inks** (colour bridges in ui-kit `app.css`, `text-*` / `bg-*` / `ring-*`):
  `cardSubtitleInk`, `cardTokenInk`, `cardTokenIconInk` (muted), `groupCountInk`
  (faint), `columnHeaderInk` / `columnHeaderSortedInk` (muted),
  `viewChipActiveFill` / `Ink` / `Ring` (accent / accent-foreground /
  transparent), `coverRing` (border 60%), `groupChipFill`, `softRowHoverFill`,
  `softRuleInk`, `softFrameFill`, `softFrameBorder`.
- **Toolbar**: `toolbarPadY` / `toolbarGap` (`py-toolbar`, `gap-toolbar`; sm),
  `toolbarSpaceBelow` (the fade tail's runway, read as a var), `pillPadX/Y`
  (`p-pill`; 2xs), `pillGap` (`gap-pill`), `pillDividerH` / `PadX`
  (`h-pill-divider`, `px-pill-divider`; 1.25rem / 2xs), `searchWidth` /
  `searchWidthNarrow` (`w-search` 12rem, `w-search-narrow` unset = 8rem).
- **View chip policy** (enumerated, read by style queries): `viewChipIcon`
  always|never, `viewChipLabel` always|active, `viewAddSeparator` show|hide
  (hide), `narrowCreateLabel` show|hide (show).
- **Card**: `cardMetaPadTop` (`pt-card-meta`; sm), `cardTitleLine` /
  `cardSubtitleLine` / `cardTokensLine` (`h-card-*-line`; 1lh),
  `cardMetaPadX` (`px-card-meta`; 0), `cardSubtitleGap` / `cardTokensGap` (`pt-card-subtitle` / `pt-card-tokens`;
  0), `cardSubtitleLines` (`line-clamp-card-subtitle`; 1), `cardTokenGap`
  (`gap-card-token`; md), `cardTokenIconSize` (`size-card-token-icon`;
  `--spacing` × 3.5 = 0.875rem), `cardTokenIconGap` (`gap-card-token-icon`;
  2xs).
- **Cover**: `coverLift` (`translate-cover-lift`; `--spacing` × 0.5 = 0.125rem), `coverZoom`
  (`scale-cover-zoom`; 1), `coverHoverFilter` (`filter-cover-hover`; none),
  `coverPrimarySize` (`size-cover-primary`; unset), `coverPrimaryInset` /
  `coverChipInset` (sm, read as vars).
- **Groups**: `groupHeaderGap` (`gap-group-header`; sm), `groupHeaderPadY`
  (`py-group-header`; `--pad-row-y`), `groupHeaderSpaceBelow`
  (`mb-group-header`; 0), `groupGap` (`gap-group`; 0), `groupRuleStart` /
  `groupRuleEnd` (`mx-group-rule`; 0, the rule's own margins), `groupChevronSize`
  (`size-group-chevron`; 1.15em = `icon-auto`), `groupChipSize` /
  `groupChipRadius` / `groupChipIconSize` (`size-group-chip`,
  `rounded-group-chip`, `size-group-chip-icon`).
- **Soft table** (a new presentation no surface uses yet): `softRowH`
  (`min-h-soft-row`), `softRowPad` / `softRowPadEnd` (`p-soft-row`; the end
  defaults to `softRowPad`), `softRowRadius`
  (`rounded-soft-row`), `softColGap` (`gap-x-soft`), `softRuleOpacity`
  (`opacity-soft-rule`), `softRuleStart` / `softRuleEnd` (`ms-soft-rule`,
  `me-soft-rule`; 0), `softHeaderH` /
  `softHeaderSpaceBelow` (`h-soft-header`, `mb-soft-header`), the frame
  (`rounded-soft-frame`, `p-soft-frame`, `shadow-soft-frame`,
  `backdrop-soft-frame`; `softFrameBackdrop` none), `titleCellLineGap`
  (`pt-title-cell-subtitle`; 0, title ↔ subtitle in a stacked title cell), the thumb
  (`size-soft-thumb`, `rounded-soft-thumb`, `softThumbNarrowW` unset),
  `columnHeaderCase` upper|none, `columnHeaderTracking`
  (`tracking-column-header`; 0.05em, the grid's `tracking-wider`), `sortIcon`
  always|sorted.

The pane's shared content inset is not here: it is density's `contentInset`
(`--pane-inset`, `rail-follow`'s floor).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: DataView token group (each part's type pick — rung, emphasis, family — plus the inks and metrics of the toolbar pills, view chips, gallery card and cover, group headers and the soft table; every default reproduces today's look) with its customizer section.
- Web:
  - Contributes:
    - `ThemeEngine.TokenGroup` "DataView"
    - `ThemeCustomizer.Section` "DataView" → `DataViewTokensSection`
  - Uses:
    - `primitives/collapsible.Collapsible`
    - `primitives/collapsible.CollapsibleContent`
    - `primitives/css/row.SectionHeaderRow`
    - `primitives/css/spacing.Stack`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/loading.Loading`
    - `ui/theme-engine.ThemeEngine`
    - `ui/theme-engine/theme-customizer.ThemeCustomizer`
    - `ui/theme-engine/theme-customizer.TokenRows`
    - `ui/theme-engine/theme-customizer.useTokenGroupEditor`
- Core:
  - Uses:
    - `primitives/css/text.PICK_EMPHASES`
    - `primitives/css/text.PICK_FAMILIES`
    - `primitives/css/text.PICK_RUNGS`
    - `primitives/css/text.PICK_STEPS`
    - `primitives/css/text.PickRung`
    - `primitives/css/text.RolePart`
    - `ui/theme-engine.defineTokenGroup`
    - `ui/theme-engine.tokenVarName`
  - Exports (types):
    - `DataViewPickedPart`
    - `DataViewTokenValues`
  - Exports (values):
    - `DATA_VIEW_PICKS`
    - `dataViewGroup`
- Cross-plugin:
  - Uses tokens: 25 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/density` ×11
    - `ui/tokens/color-palette` ×6
    - `ui/tokens/type-scale` ×5
    - `ui/tokens/shape` ×2
    - `ui/tokens/shadow --shadow`
  - Tokens used by:
    - `primitives/css/row`
    - `primitives/css/ui-kit`
    - `primitives/data-table`
    - `primitives/data-view`
    - `primitives/data-view/gallery`
    - `primitives/data-view/table`
    - `primitives/data-view/view-core`
    - `ui/theme-engine`

<!-- AUTOGENERATED:END -->
