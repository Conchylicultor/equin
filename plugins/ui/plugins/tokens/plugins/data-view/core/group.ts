import {
  PICK_EMPHASES,
  PICK_FAMILIES,
  PICK_RUNGS,
  PICK_STEPS,
  type PickRung,
  type RolePart,
} from "@plugins/primitives/plugins/css/plugins/text/core";
import {
  defineTokenGroup,
  tokenVarName,
} from "@plugins/ui/plugins/theme-engine/core";

/**
 * Each picked part and its fallback rung (= its default role, today's). A
 * part's three tokens (`<part>Role` / `Emphasis` / `Family`, enumerated over
 * the closed `PICK_*` vocabulary — type-scale rule 6b) are written out in the
 * schema below: the token-usage reader needs every key literally.
 */
const PICKED_PARTS = {
  viewChip: "caption",
  search: "caption",
  create: "control",
  cardTitle: "label",
  cardSubtitle: "caption",
  cardToken: "caption",
  cardTokenNumeric: "code",
  groupLabel: "group",
  groupCount: "group",
  columnHeader: "caption",
  titleCell: "caption",
  titleCellSubtitle: "caption",
  cell: "caption",
  cellNumeric: "caption",
} as const satisfies Record<string, PickRung>;

export type DataViewPickedPart = keyof typeof PICKED_PARTS;

/**
 * How a DataView looks, part by part: the type each part picks, its inks, and
 * the metrics of the toolbar, the gallery card and its cover, the group
 * headers, and the soft table presentation.
 *
 * **Every default is the modern DataView look** (a flat toolbar strip, soft
 * neutral view chips, caption group headers, sentence-case faint column
 * captions, hover-revealed affordances), so a theme that says nothing about
 * the group gets it; a theme that wants the earlier, heavier chrome (boxed
 * pills, accent chips, UPPERCASE headers, a sort arrow on every column, ruled
 * group headers) restores it by setting the values back — and an app theme
 * that wants a different DataView altogether (Sonata, Prototypes) sets its
 * own. A default of `initial` is UNSET: the consumer's own fallback applies
 * (`var(--x, <fallback>)`).
 *
 * Type is picked, never sized: a part's `…Role` names a rung of the closed
 * ladder (or 2xs / 3xs), `…Emphasis` a shared weight (`parent` = the weight of
 * the control the words sit in), `…Family` sans / mono — the type-scale group
 * still owns every metric, and `--font-scale` still scales them.
 */
export const dataViewGroup = defineTokenGroup("data-view", {
  // Whether every pick steps down to its rung's compact form inside a compact
  // (`xs`) region, as the variant it replaced did (`ambient`), or draws the
  // rung it names (`base`) — a theme whose picks are measured off a mockup.
  pickStep: {
    default: "ambient",
    label: "Type picks in compact regions",
    values: PICK_STEPS,
  },
  // ── Type picks ─────────────────────────────────────────────────────────
  // A view chip's name: the chip's caption size at the chip's (`font-tag`)
  // weight.
  viewChipRole: {
    default: "caption",
    label: "View chip type role",
    values: PICK_RUNGS,
  },
  viewChipEmphasis: {
    default: "parent",
    label: "View chip emphasis",
    values: PICK_EMPHASES,
  },
  viewChipFamily: {
    default: "role",
    label: "View chip family",
    values: PICK_FAMILIES,
  },
  // The toolbar search field's text (a `sm` field: caption).
  searchRole: {
    default: "caption",
    label: "Search type role",
    values: PICK_RUNGS,
  },
  searchEmphasis: {
    default: "role",
    label: "Search emphasis",
    values: PICK_EMPHASES,
  },
  searchFamily: {
    default: "role",
    label: "Search family",
    values: PICK_FAMILIES,
  },
  // The create button's label (a `Button`: the control role).
  createRole: {
    default: "control",
    label: "Create type role",
    values: PICK_RUNGS,
  },
  createEmphasis: {
    default: "role",
    label: "Create emphasis",
    values: PICK_EMPHASES,
  },
  createFamily: {
    default: "role",
    label: "Create family",
    values: PICK_FAMILIES,
  },
  // The gallery card's three lines (`CardMeta`).
  cardTitleRole: {
    default: "label",
    label: "Card title type role",
    values: PICK_RUNGS,
  },
  cardTitleEmphasis: {
    default: "role",
    label: "Card title emphasis",
    values: PICK_EMPHASES,
  },
  cardTitleFamily: {
    default: "role",
    label: "Card title family",
    values: PICK_FAMILIES,
  },
  cardSubtitleRole: {
    default: "caption",
    label: "Card subtitle type role",
    values: PICK_RUNGS,
  },
  cardSubtitleEmphasis: {
    default: "role",
    label: "Card subtitle emphasis",
    values: PICK_EMPHASES,
  },
  cardSubtitleFamily: {
    default: "role",
    label: "Card subtitle family",
    values: PICK_FAMILIES,
  },
  cardTokenRole: {
    default: "caption",
    label: "Card token type role",
    values: PICK_RUNGS,
  },
  cardTokenEmphasis: {
    default: "role",
    label: "Card token emphasis",
    values: PICK_EMPHASES,
  },
  cardTokenFamily: {
    default: "role",
    label: "Card token family",
    values: PICK_FAMILIES,
  },
  cardTokenNumericRole: {
    default: "code",
    label: "Card numeric token type role",
    values: PICK_RUNGS,
  },
  cardTokenNumericEmphasis: {
    default: "role",
    label: "Card numeric token emphasis",
    values: PICK_EMPHASES,
  },
  cardTokenNumericFamily: {
    default: "role",
    label: "Card numeric token family",
    values: PICK_FAMILIES,
  },
  // A standard group header's label and its count.
  groupLabelRole: {
    default: "group",
    label: "Group label type role",
    values: PICK_RUNGS,
  },
  groupLabelEmphasis: {
    default: "role",
    label: "Group label emphasis",
    values: PICK_EMPHASES,
  },
  groupLabelFamily: {
    default: "role",
    label: "Group label family",
    values: PICK_FAMILIES,
  },
  groupCountRole: {
    default: "group",
    label: "Group count type role",
    values: PICK_RUNGS,
  },
  groupCountEmphasis: {
    default: "role",
    label: "Group count emphasis",
    values: PICK_EMPHASES,
  },
  groupCountFamily: {
    default: "role",
    label: "Group count family",
    values: PICK_FAMILIES,
  },
  // The table's column labels (the caption role, at a medium weight).
  columnHeaderRole: {
    default: "caption",
    label: "Column header type role",
    values: PICK_RUNGS,
  },
  columnHeaderEmphasis: {
    default: "medium",
    label: "Column header emphasis",
    values: PICK_EMPHASES,
  },
  columnHeaderFamily: {
    default: "role",
    label: "Column header family",
    values: PICK_FAMILIES,
  },
  // A table's title cell (two lines under `titleCell: "stacked"`) and its
  // other cells (the grid row's caption).
  titleCellRole: {
    default: "caption",
    label: "Title cell type role",
    values: PICK_RUNGS,
  },
  titleCellEmphasis: {
    default: "role",
    label: "Title cell emphasis",
    values: PICK_EMPHASES,
  },
  titleCellFamily: {
    default: "role",
    label: "Title cell family",
    values: PICK_FAMILIES,
  },
  titleCellSubtitleRole: {
    default: "caption",
    label: "Title cell subtitle type role",
    values: PICK_RUNGS,
  },
  titleCellSubtitleEmphasis: {
    default: "role",
    label: "Title cell subtitle emphasis",
    values: PICK_EMPHASES,
  },
  titleCellSubtitleFamily: {
    default: "role",
    label: "Title cell subtitle family",
    values: PICK_FAMILIES,
  },
  cellRole: {
    default: "caption",
    label: "Cell type role",
    values: PICK_RUNGS,
  },
  cellEmphasis: {
    default: "role",
    label: "Cell emphasis",
    values: PICK_EMPHASES,
  },
  cellFamily: {
    default: "role",
    label: "Cell family",
    values: PICK_FAMILIES,
  },
  // A soft row's cell whose value is a number (mono figures in a theme that
  // wants them), as a card's numeric token is to its text token. Default =
  // the cell's own pick.
  cellNumericRole: {
    default: "caption",
    label: "Numeric cell type role",
    values: PICK_RUNGS,
  },
  cellNumericEmphasis: {
    default: "role",
    label: "Numeric cell emphasis",
    values: PICK_EMPHASES,
  },
  cellNumericFamily: {
    default: "role",
    label: "Numeric cell family",
    values: PICK_FAMILIES,
  },

  // ── Inks ───────────────────────────────────────────────────────────────
  cardSubtitleInk: {
    default: "var(--muted-foreground)",
    label: "Card subtitle ink",
  },
  cardTokenInk: { default: "var(--muted-foreground)", label: "Card token ink" },
  cardTokenIconInk: {
    default: "var(--muted-foreground)",
    label: "Card token icon ink",
  },
  // A group header's label (muted: the header reads as a caption).
  groupLabelInk: {
    default: "var(--muted-foreground)",
    label: "Group label ink",
  },
  // A soft row's cells (default: the row's own ink, inherited).
  cellInk: { default: "currentColor", label: "Cell ink" },
  groupCountInk: {
    default: "var(--faint-foreground)",
    label: "Group count ink",
  },
  columnHeaderInk: {
    default: "var(--faint-foreground)",
    label: "Column header ink",
  },
  // The sorted column's label stands out from the faint others.
  columnHeaderSortedInk: {
    default: "var(--foreground)",
    label: "Sorted column header ink",
  },
  // The active view chip: a soft neutral fill, the foreground ink, no ring
  // (the old look: `var(--accent)` / `var(--accent-foreground)`).
  viewChipActiveFill: {
    default: "color-mix(in oklab, var(--foreground) 7%, transparent)",
    label: "Active view fill",
  },
  viewChipActiveInk: {
    default: "var(--foreground)",
    label: "Active view ink",
  },
  viewChipActiveRing: { default: "transparent", label: "Active view ring" },
  // The rule before the add-view button and before Create (`bg-border`).
  pillDividerInk: { default: "var(--border)", label: "Pill divider ink" },
  // The toolbar's search well (the `filled` field: `bg-muted`, the theme
  // radius, a faint 14px glyph, its text after `pl-xl`).
  searchFill: { default: "var(--muted)", label: "Search fill" },
  searchIconInk: {
    default: "var(--faint-foreground)",
    label: "Search icon ink",
  },
  // The cover's hairline, drawn over the picture (`ring-border/60`).
  coverRing: {
    default: "color-mix(in oklab, var(--border) 60%, transparent)",
    label: "Cover ring",
  },

  // ── Toolbar (`PillsToolbar`) ───────────────────────────────────────────
  // Whether a toolbar pill draws its own surface (`float`: fill, border,
  // shadow, blur, padding — the old boxed look) or sits flat on the band
  // (`flat`). An overlay pill (the floating toolbar) keeps its glass either way.
  toolbarPillSurface: {
    default: "flat",
    label: "Toolbar pill surface",
    values: ["flat", "float"] as const,
  },
  // The row's block padding (`py-sm`) and the gap between its pills
  // (`gap-sm`); the room under the band (the fade tail's runway).
  toolbarPadY: { default: "var(--space-sm)", label: "Toolbar block padding" },
  toolbarGap: { default: "var(--space-sm)", label: "Toolbar gap" },
  toolbarSpaceBelow: {
    default: "calc(var(--sticky-fade-tail) - var(--space-sm))",
    label: "Space below toolbar",
  },
  // A pill's padding (`p-2xs`) and the gap between its items (`gap-2xs`).
  pillPadX: { default: "var(--space-2xs)", label: "Pill inline padding" },
  pillPadY: { default: "var(--space-2xs)", label: "Pill block padding" },
  pillGap: { default: "var(--space-2xs)", label: "Pill gap" },
  // The divider before Create (`h-5 px-2xs`).
  pillDividerH: { default: "1.25rem", label: "Pill divider height" },
  pillDividerPadX: {
    default: "var(--space-2xs)",
    label: "Pill divider padding",
  },
  // The search field's lane (`w-48`); on a narrow band, unset = today's.
  searchWidth: { default: "12rem", label: "Search width" },
  searchWidthNarrow: { default: "initial", label: "Search width (narrow)" },
  searchRadius: { default: "var(--radius)", label: "Search radius" },
  searchIconSize: {
    default: "calc(var(--spacing) * 3.5)",
    label: "Search icon size",
  },
  searchTextStart: { default: "var(--space-xl)", label: "Search text start" },
  // A labelled Create button's inline padding; unset = the button's own.
  createPadStart: { default: "initial", label: "Create padding start" },
  createPadEnd: { default: "initial", label: "Create padding end" },
  createRadius: { default: "initial", label: "Create radius" },
  // Both sides on a narrow band whose theme drops the words
  // (`narrowCreateLabel: hide`); unset = `createPadStart`.
  createPadNarrow: { default: "initial", label: "Create padding (narrow)" },

  // ── View chip policy ───────────────────────────────────────────────────
  viewChipIcon: {
    default: "always",
    label: "View chip icon",
    values: ["always", "never"] as const,
  },
  viewChipLabel: {
    default: "always",
    label: "View chip label",
    values: ["always", "active"] as const,
  },
  // The active chip's inline padding; unset = the chip's own.
  viewChipActivePadStart: {
    default: "initial",
    label: "Active view padding start",
  },
  viewChipActivePadEnd: {
    default: "initial",
    label: "Active view padding end",
  },
  // A chip's glyph (`icon-auto`: 1.15em of the chip's text) and the gap
  // between glyph and name (the `md` chip's `gap-control-sm`).
  viewChipIconSize: { default: "1.15em", label: "View chip icon size" },
  viewChipGap: { default: "var(--control-gap-sm)", label: "View chip gap" },
  // The `md` chip's corners (a soft 7px; the old look: `calc(infinity *
  // 1px)`, fully round) and the add-view button's (unset = the icon button's
  // own).
  viewChipRadius: { default: "0.4375rem", label: "View chip radius" },
  viewAddRadius: { default: "initial", label: "Add-view radius" },
  // The switcher's gaps: between two chips, and around the add-view rule and
  // button (`gap-xs` both).
  viewChipSpacing: { default: "var(--space-xs)", label: "View chip spacing" },
  viewSwitcherGap: { default: "var(--space-xs)", label: "View switcher gap" },
  // A separator between the view chips and the add-view button.
  viewAddSeparator: {
    default: "hide",
    label: "Add-view separator",
    values: ["show", "hide"] as const,
  },
  // Whether the add-view button shows at rest (`always`) or only while the
  // view strip is hovered or holds focus (`hover`; it stays tabbable).
  viewAddReveal: {
    default: "hover",
    label: "Add-view reveal",
    values: ["always", "hover"] as const,
  },
  // Whether the search well carries its trailing `/` key hint.
  searchShortcutHint: {
    default: "show",
    label: "Search shortcut hint",
    values: ["show", "hide"] as const,
  },
  // Whether a narrow band keeps the create button's label.
  narrowCreateLabel: {
    default: "show",
    label: "Create label (narrow)",
    values: ["show", "hide"] as const,
  },

  // ── Gallery card (`CardMeta`, `DataCard`) ──────────────────────────────
  // Between the cover and the text (`gap-sm`).
  // A section's grid band's block padding (`py-sm`).
  galleryBodyPadY: {
    default: "var(--space-sm)",
    label: "Gallery band block padding",
  },
  cardMetaPadTop: { default: "var(--space-sm)", label: "Card text offset" },
  // The text's inline inset from the cover's edges (none: flush with it).
  cardMetaPadX: { default: "0px", label: "Card text side inset" },
  // Each line's box (one line of its own type) and the gaps between them.
  cardTitleLine: { default: "1lh", label: "Card title line box" },
  cardSubtitleLine: { default: "1lh", label: "Card subtitle line box" },
  cardTokensLine: { default: "1lh", label: "Card tokens line box" },
  cardSubtitleGap: { default: "0px", label: "Card subtitle gap" },
  cardTokensGap: { default: "0px", label: "Card tokens gap" },
  // How many lines the subtitle may take (clamped, fixed height).
  cardSubtitleLines: { default: "1", label: "Card subtitle lines" },
  // Between two tokens (`gap-md`), and a token's icon (`size-3.5`, which
  // scales with the shape group's base `--spacing`, so the default does too).
  cardTokenGap: { default: "var(--space-md)", label: "Card token gap" },
  cardTokenIconSize: {
    default: "calc(var(--spacing) * 3.5)",
    label: "Card token icon size",
  },
  // Between a token's icon and its value (`gap-2xs`).
  cardTokenIconGap: {
    default: "var(--space-2xs)",
    label: "Card token icon gap",
  },

  // ── Cover (`CoverFrame`) ───────────────────────────────────────────────
  // Whether a card with no cover and no leading field draws a monogram tile
  // (`show`) or the blank frame (`hide`).
  coverMonogram: {
    default: "show",
    label: "Cover monogram",
    values: ["show", "hide"] as const,
  },
  // How far it rises on the card's hover (`-translate-y-0.5`, on the base
  // `--spacing` like the class it replaced), how much it
  // zooms and what filter it takes then.
  coverLift: {
    default: "calc(var(--spacing) * 0.5)",
    label: "Cover hover lift",
  },
  coverZoom: { default: "1", label: "Cover hover zoom" },
  // The frame's own fill behind its picture (`bg-muted`), and its hairline
  // on the card's hover (default: the resting one).
  coverFill: { default: "var(--muted)", label: "Cover fill" },
  coverRingHover: { default: "var(--cover-ring)", label: "Cover ring (hover)" },
  coverHoverFilter: { default: "none", label: "Cover hover filter" },
  // The primary action over the cover: its size (unset = the action's own)
  // and its inset (`Pin offset="sm"`); the action chips' inset.
  coverPrimarySize: { default: "initial", label: "Cover primary size" },
  // Its button's fill, ink and shadow; unset = what the action draws itself.
  coverPrimaryFill: { default: "initial", label: "Cover primary fill" },
  coverPrimaryInk: { default: "initial", label: "Cover primary ink" },
  coverPrimaryShadow: { default: "initial", label: "Cover primary shadow" },
  coverPrimaryInset: {
    default: "var(--space-sm)",
    label: "Cover primary inset",
  },
  coverChipInset: { default: "var(--space-sm)", label: "Cover chip inset" },

  // ── Group headers (`DataViewGroupHeader`, `GroupedSections`) ───────────
  // How a group header draws: the label and count as a caption (`caption`),
  // followed by a hairline to the row's end (`rule`), or the label in a soft
  // pill (`pill`).
  groupHeaderStyle: {
    default: "caption",
    label: "Group header style",
    values: ["caption", "rule", "pill"] as const,
  },
  // The `pill` style's fill and inline padding.
  groupPillFill: {
    default: "color-mix(in oklab, var(--foreground) 7%, transparent)",
    label: "Group pill fill",
  },
  groupPillPadX: { default: "var(--space-sm)", label: "Group pill padding" },
  // The header row's gap (`gap-sm`) and block padding (`p-row`), the room
  // under it, the room between two groups, its chevron (`icon-auto`).
  groupHeaderGap: { default: "var(--space-sm)", label: "Group header gap" },
  groupHeaderPadY: {
    default: "var(--pad-row-y)",
    label: "Group header block padding",
  },
  groupHeaderSpaceBelow: {
    default: "0px",
    label: "Space below group header",
  },
  groupGap: { default: "0px", label: "Group gap" },
  groupChevronSize: { default: "1.15em", label: "Group chevron size" },
  // The rule's own room on either side, beyond the header's gap (none).
  groupRuleStart: { default: "0px", label: "Group rule start margin" },
  groupRuleEnd: { default: "0px", label: "Group rule end margin" },
  // The identity chip before the label (drawn only for a section with an
  // icon — no surface has one today).
  groupChipSize: { default: "1.5rem", label: "Group chip size" },
  groupChipRadius: {
    default: "calc(var(--radius) * 0.8)",
    label: "Group chip radius",
  },
  groupChipFill: {
    default: "color-mix(in oklab, currentColor 14%, transparent)",
    label: "Group chip fill",
  },
  groupChipIconSize: { default: "0.875rem", label: "Group chip icon size" },

  // ── Soft table (the `soft` presentation — new, used by no surface yet) ──
  softRowH: { default: "3rem", label: "Soft row height" },
  softRowPad: { default: "var(--space-sm)", label: "Soft row padding" },
  // The row's end-side padding (default: the same as every other side).
  softRowPadEnd: {
    default: "var(--soft-row-pad)",
    label: "Soft row padding end",
  },
  softRowRadius: {
    default: "calc(var(--radius) * 0.8)",
    label: "Soft row radius",
  },
  softColGap: { default: "var(--space-md)", label: "Soft column gap" },
  softRowHoverFill: {
    default: "color-mix(in oklab, var(--accent) 50%, transparent)",
    label: "Soft row hover fill",
  },
  // The hairline between rows: its ink, opacity and where it starts.
  softRuleInk: { default: "var(--border)", label: "Soft rule ink" },
  softRuleOpacity: { default: "0.6", label: "Soft rule opacity" },
  softRuleStart: { default: "0px", label: "Soft rule start" },
  // How far short of the row's end edge the hairline stops.
  softRuleEnd: { default: "0px", label: "Soft rule end inset" },
  softHeaderH: { default: "1.75rem", label: "Soft header height" },
  softHeaderSpaceBelow: {
    default: "var(--space-xs)",
    label: "Space below soft header",
  },
  // An optional frame around the table (none by default).
  softFrameFill: { default: "transparent", label: "Soft frame fill" },
  softFrameBorder: { default: "transparent", label: "Soft frame border" },
  softFrameBorderWidth: { default: "1px", label: "Soft frame border width" },
  softFrameShadow: { default: "none", label: "Soft frame shadow" },
  softFrameRadius: { default: "0px", label: "Soft frame radius" },
  softFramePad: { default: "0px", label: "Soft frame padding" },
  // What the frame does to what shows through it (none: no filter).
  softFrameBackdrop: { default: "none", label: "Soft frame backdrop filter" },
  // Between a stacked title cell's title and its subtitle line.
  titleCellLineGap: { default: "0px", label: "Title cell line gap" },
  // The cover thumbnail column (default = the list's cover thumb).
  softThumbW: { default: "var(--cover-thumb-w)", label: "Soft thumb width" },
  softThumbH: { default: "var(--cover-thumb-h)", label: "Soft thumb height" },
  softThumbRadius: {
    default: "calc(var(--radius) * 0.8)",
    label: "Soft thumb radius",
  },
  softThumbNarrowW: { default: "initial", label: "Soft thumb width (narrow)" },
  // The column labels' case and tracking (sentence case, untracked; the old
  // look: `upper` / `0.05em`).
  columnHeaderCase: {
    default: "none",
    label: "Column header case",
    values: ["upper", "none"] as const,
  },
  columnHeaderTracking: {
    default: "0em",
    label: "Column header tracking",
  },
  // Whether an unsorted column shows its sort arrow: always, never
  // (`sorted`: only the sorted column's), or on the header's hover (`hover`).
  sortIcon: {
    default: "hover",
    label: "Sort icon",
    values: ["always", "sorted", "hover"] as const,
  },
  // ── List rows ──────────────────────────────────────────────────────────
  // The gap between a list row's aligned trailing slots, and the ink of a
  // time-typed trailing value.
  listSlotGap: { default: "var(--space-md)", label: "List slot gap" },
  listTimeInk: {
    default: "var(--faint-foreground)",
    label: "List time ink",
  },
});

export type DataViewTokenValues = {
  [K in keyof typeof dataViewGroup.schema]: string;
};

/**
 * Each picked part's `RolePart` — the CSS vars of its three tokens and its
 * fallback rung — for `<Text pick={DATA_VIEW_PICKS.cardTitle}>` /
 * `rolePickClass` + `rolePickScope` (text web).
 */
export const DATA_VIEW_PICKS = Object.fromEntries(
  Object.entries(PICKED_PARTS).map(([part, fallback]) => [
    part,
    {
      role: tokenVarName(`${part}Role`),
      emphasis: tokenVarName(`${part}Emphasis`),
      family: tokenVarName(`${part}Family`),
      step: tokenVarName("pickStep"),
      fallback,
    } as RolePart,
  ]),
) as Record<DataViewPickedPart, RolePart>;
