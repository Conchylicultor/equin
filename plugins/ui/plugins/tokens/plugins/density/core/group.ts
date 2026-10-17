import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

export const densityGroup = defineTokenGroup("density", {
  padChipX: { default: "0.375rem", label: "Chip padding X" },
  padChipY: { default: "0.125rem", label: "Chip padding Y" },
  padRowX: { default: "0.5rem", label: "Row padding X" },
  padRowY: { default: "0.375rem", label: "Row padding Y" },
  padCard: { default: "0.75rem", label: "Card padding" },
  // The compact row rung — a table on a surface that declared itself compact
  // (`DataTable density="compact"`, `py-row-compact`). Default = a third of the
  // row pad, so it scales with the preset (Comfortable's 0.375rem → 0.125rem,
  // Compact's own row pad); a theme sets it to give dense rows their own rhythm.
  padRowCompactY: {
    default: "calc(var(--pad-row-y) / 3)",
    label: "Compact row padding Y",
  },
  // The compact (`xs`) chip rung — a count chip in a dense list row. Defaults
  // read the chip pad and the `rounded-md` radius, so a theme that leaves them
  // out paints the compact chip exactly like every other chip; a theme sets
  // them to give the dense rung its own, tighter shape.
  padChipCompactX: {
    default: "var(--pad-chip-x)",
    label: "Compact chip padding X",
  },
  padChipCompactY: {
    default: "var(--pad-chip-y)",
    label: "Compact chip padding Y",
  },
  radiusChipCompact: {
    default: "calc(var(--radius) * 0.8)",
    label: "Compact chip radius",
  },
  // A status dot's diameter per density tier (`StatusDot` reads the ambient
  // `ControlSize`). Defaults are the old `size-1` … `size-2.5`.
  statusDotXs: { default: "0.25rem", label: "Status dot XS" },
  statusDotSm: { default: "0.375rem", label: "Status dot SM" },
  statusDotMd: { default: "0.5rem", label: "Status dot MD" },
  statusDotLg: { default: "0.625rem", label: "Status dot LG" },
  // One control size = one bundle: its height, its inline padding and the gap
  // between its icon and its label. All three are tokens, so a preset owns a
  // control's width rhythm as well as its height. There is no block padding: a
  // control's height is fixed and its content centred, so it would do nothing.
  controlHeightXs: { default: "1.5rem", label: "Control height XS" },
  controlHeightSm: { default: "1.75rem", label: "Control height SM" },
  controlHeightMd: { default: "2rem", label: "Control height MD" },
  controlHeightLg: { default: "2.25rem", label: "Control height LG" },
  controlPadXs: { default: "0.5rem", label: "Control padding XS" },
  controlPadSm: { default: "0.625rem", label: "Control padding SM" },
  controlPadMd: { default: "0.625rem", label: "Control padding MD" },
  controlPadLg: { default: "0.625rem", label: "Control padding LG" },
  controlGapXs: { default: "0.25rem", label: "Control gap XS" },
  // `sm` sets the same 14px label as `md` (only `xs` drops a type rung), so
  // its gap is `md`'s: a shorter box, never a tighter label. Every preset keeps
  // the two equal.
  controlGapSm: { default: "0.375rem", label: "Control gap SM" },
  controlGapMd: { default: "0.375rem", label: "Control gap MD" },
  controlGapLg: { default: "0.375rem", label: "Control gap LG" },
  // The glyph inside a control, per size (Button's `[&_svg]`, IconButton
  // inherits). Defaults are the old `size-3` at `xs` and `size-4` above it.
  controlIconXs: { default: "0.75rem", label: "Control icon XS" },
  controlIconSm: { default: "1rem", label: "Control icon SM" },
  controlIconMd: { default: "1rem", label: "Control icon MD" },
  controlIconLg: { default: "1rem", label: "Control icon LG" },
  // A rendered document's reading inset (the file viewer's Markdown body).
  // Defaults = the `py-md` / `px-lg` it always had; a theme (or a document
  // sub-theme) sets them to give the page its own margins.
  documentPadTop: { default: "var(--space-md)", label: "Document padding top" },
  documentPadX: { default: "var(--space-lg)", label: "Document padding X" },
  documentPadBottom: {
    default: "var(--space-md)",
    label: "Document padding bottom",
  },
  chromeBarH: { default: "3rem", label: "Chrome bar height" },
  chromePaneH: { default: "2.5rem", label: "Chrome pane header height" },
  chromePadX: { default: "0.75rem", label: "Chrome padding X" },
  // A pane header's bottom rule width (`Bar tier="pane"`). Default = the 1px
  // `border-b` every bar draws; `0` runs the header into its pane.
  chromePaneRule: { default: "1px", label: "Pane header rule" },
  // A tree row (`TreeRowChrome`): its minimum height and the indent per depth
  // level. Defaults = the old `min-h-7` and 16px step. The indent stays in px:
  // e2e reads it back as a number.
  treeRowH: { default: "1.75rem", label: "Tree row height" },
  treeIndent: { default: "16px", label: "Tree indent" },
  // A tree row's leading inset (before its icon / chevron slot) and the gap
  // between its cells. Defaults = the 4px lead and `xs` gap it always had.
  treeRowPadStart: { default: "4px", label: "Tree row lead inset" },
  treeRowGap: { default: "var(--space-xs)", label: "Tree row gap" },
  // How much of each depth level's indent moves the row's PILL (its hover /
  // selected fill) rather than only its content. Default `0px`: every pill
  // spans the full width and only its content indents; at `--tree-indent` a
  // nested row's fill starts under its parent's icon. Never above the indent.
  treePillIndent: { default: "0px", label: "Tree pill indent" },
  // Where an indent guide's hairline sits inside its indent step (its centre,
  // from the step's start). Default = the step's middle.
  treeGuideX: {
    default: "calc(var(--tree-indent) / 2)",
    label: "Tree guide offset",
  },
  // The gap between a tree's top-level rows.
  // Default = the `2xs` step it always had; `0px` packs root rows like
  // nested ones.
  treeRootGap: { default: "var(--space-2xs)", label: "Tree root row gap" },
  // A MENU's width bounds. A plain menu (`menu-fit`, `DropdownMenuContent`'s
  // default; Select's floor) sizes to its items between the two; a control
  // panel (`menu`, multi-page, so it must not resize as you move through it)
  // is fixed at the max, so it is exactly as wide as the widest plain menu.
  // A theme that wants every menu one width sets both to the same value.
  // Defaults = the Menu prototype's 200px / 300px.
  popoverWidthMenuMin: { default: "12.5rem", label: "Menu minimum width" },
  popoverWidthMenuMax: { default: "18.75rem", label: "Menu maximum width" },
  // The other fixed popover width ROLES (`PopoverContent width`) — a
  // six-track rule row, a panel whose body is a grid.
  popoverWidthBuilder: {
    default: "32.75rem",
    label: "Builder popover width",
  },
  popoverWidthPicker: { default: "20rem", label: "Picker popover width" },
  // A hover card (`overlay/hover-card`): one fixed width for every card, so
  // a card never resizes as the pointer moves from one subject to the next.
  // Default = the workspace-menu mock's 250px card.
  popoverWidthCard: { default: "15.75rem", label: "Hover card width" },
  // A list of choices that each carry a visible description line (the
  // page-kind menu), whose width decides how many lines each description
  // wraps to. Default = the Menu prototype's 280px described menu.
  popoverWidthDescribed: {
    default: "17.5rem",
    label: "Described-menu popover width",
  },
  // A control panel's geometry (`ControlPanel`): the panel's own inset — which
  // also spaces its bands — and its row height. Defaults = the `xs` step and
  // the `md` control height it always used, so a panel row is as tall as a
  // Button unless a theme says otherwise.
  panelPad: { default: "var(--space-xs)", label: "Panel padding" },
  panelRowH: { default: "var(--control-height-md)", label: "Panel row height" },
  // A DataView section header's block padding (the `sections` chrome's
  // `ViewSection`): above and below its label row. Defaults = the row padding
  // (`padRowY`) every `Row` has. A theme that spaces its sections apart puts
  // that space ABOVE each header (so a section's rows sit right under it).
  // The gap between a DataView list section's header and its first row (the
  // section body's top padding). Default = the `sm` step it always had; a
  // theme whose section heads sit tight on their rows sets less.
  sectionBodyPadTop: {
    default: "var(--space-sm)",
    label: "Section body padding top",
  },
  sectionHeadPadTop: {
    default: "var(--pad-row-y)",
    label: "Section header padding top",
  },
  sectionHeadPadBottom: {
    default: "var(--pad-row-y)",
    label: "Section header padding bottom",
  },
  // A pane header's own inline insets (`Bar tier="pane"`): before its leading
  // control and after its last one. Default = the shared `chromePadX`.
  chromePanePadStart: {
    default: "var(--chrome-pad-x)",
    label: "Pane header padding start",
  },
  chromePanePadEnd: {
    default: "var(--chrome-pad-x)",
    label: "Pane header padding end",
  },
  // The inline inset of a pane's secondary strip under its header
  // (`Bar tier="subpane"`, the conversation toolbar). Default = the `sm` step.
  subpanePadX: {
    default: "var(--space-sm)",
    label: "Sub-pane strip padding X",
  },
  // A conversation thread's cards (the user's message, a collapsible tool or
  // meta row): default = the `md` × `sm` steps they always wore.
  padThreadCardX: {
    default: "var(--space-md)",
    label: "Thread card padding X",
  },
  padThreadCardY: {
    default: "var(--space-sm)",
    label: "Thread card padding Y",
  },
  // The prompt box (text-editor `EditorShell`): the box's own padding, the
  // editable text's (and its placeholder's) padding inside it, and the padding
  // of the action row under the text. Defaults = none on the box, `xs` × `sm`
  // on the text, `sm` sides and an `xs` foot on the row — as always.
  padComposer: { default: "0", label: "Composer padding" },
  padComposerText: {
    default: "var(--space-xs) var(--space-sm)",
    label: "Composer text padding",
  },
  padComposerActions: {
    default: "0 var(--space-sm) var(--space-xs)",
    label: "Composer actions padding",
  },
  // A pane header's chips (a conversation's model and status chips). Default =
  // the regular chip pad.
  padChipHeaderX: {
    default: "var(--pad-chip-x)",
    label: "Header chip padding X",
  },
  padChipHeaderY: {
    default: "var(--pad-chip-y)",
    label: "Header chip padding Y",
  },
  // A transcript card's tool-name badge. It sits in an `xs` card, so the
  // defaults are the compact chip rung it always wore.
  padToolBadgeX: {
    default: "var(--pad-chip-compact-x)",
    label: "Tool badge padding X",
  },
  padToolBadgeY: {
    default: "var(--pad-chip-compact-y)",
    label: "Tool badge padding Y",
  },
  // An inline `code` span in rendered markdown. Defaults = the `xs` × `2xs`
  // steps.
  padCodeX: { default: "var(--space-xs)", label: "Inline code padding X" },
  padCodeY: { default: "var(--space-2xs)", label: "Inline code padding Y" },
  // The icon-only end segment of a split control (the send half of a prompt
  // template chip), whose width is its padding plus its glyph. Default = the
  // `xs` control pad it always had.
  padSplitArrowX: {
    default: "var(--control-pad-xs)",
    label: "Split arrow padding X",
  },
  // A conversation row's in-flight op glyph (build / push / check …). Default
  // = the old `size-3.5`.
  opStatusIcon: { default: "0.875rem", label: "Op status icon" },
  // 1-D spacing ramp — the closed set of gap/padding roles consumed by the
  // <Stack gap> / <Inset pad> primitives and the gap-*/p-* @utility classes.
  // Lives here (not a separate group) so layout rhythm scales with the active
  // density preset, exactly like control heights and pads. `none` (0) needs no
  // token. Comfortable seeds 1:1 with today's dominant raw usage (xs=gap-1,
  // sm=gap-2, md=gap-3, lg=gap-4, xl=gap-6, 2xl=gap-8).
  // Quoted kebab keys (like the type-scale group's `font-size-2xs`) so the
  // emitted vars are clean `--space-2xs … --space-2xl` — camelCase can't yield a
  // hyphen before a digit.
  "space-2xs": { default: "0.125rem", label: "Space 2xs" },
  "space-xs": { default: "0.25rem", label: "Space xs" },
  "space-sm": { default: "0.5rem", label: "Space sm" },
  "space-md": { default: "0.75rem", label: "Space md" },
  "space-lg": { default: "1rem", label: "Space lg" },
  "space-xl": { default: "1.5rem", label: "Space xl" },
  "space-2xl": { default: "2rem", label: "Space 2xl" },
});

export type DensityTokenValues = {
  [K in keyof typeof densityGroup.schema]: string;
};
