import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

export const colorPaletteGroup = defineTokenGroup("color-palette", {
  background: {
    default: "oklch(1 0 0)",
    darkDefault: "oklch(0.145 0 0)",
    label: "Background",
  },
  foreground: {
    default: "oklch(0.145 0 0)",
    darkDefault: "oklch(0.82 0 0)",
    label: "Text",
  },
  card: {
    default: "oklch(1 0 0)",
    darkDefault: "oklch(0.205 0 0)",
    label: "Card",
  },
  cardForeground: {
    default: "oklch(0.145 0 0)",
    darkDefault: "oklch(0.82 0 0)",
    label: "Card text",
  },
  popover: {
    default: "oklch(1 0 0)",
    darkDefault: "oklch(0.205 0 0)",
    label: "Popover",
  },
  popoverForeground: {
    default: "oklch(0.145 0 0)",
    darkDefault: "oklch(0.82 0 0)",
    label: "Popover text",
  },
  primary: {
    default: "oklch(0.44 0.09 240)",
    darkDefault: "oklch(0.44 0.09 240)",
    label: "Primary",
  },
  primaryForeground: {
    default: "oklch(0.985 0 0)",
    darkDefault: "oklch(0.985 0 0)",
    label: "On primary",
  },
  secondary: {
    default: "oklch(0.97 0 0)",
    darkDefault: "oklch(0.269 0 0)",
    label: "Secondary",
  },
  secondaryForeground: {
    default: "oklch(0.205 0 0)",
    darkDefault: "oklch(0.82 0 0)",
    label: "On secondary",
  },
  muted: {
    default: "oklch(0.97 0 0)",
    darkDefault: "oklch(0.269 0 0)",
    label: "Muted surface",
  },
  mutedForeground: {
    default: "oklch(0.556 0 0)",
    darkDefault: "oklch(0.62 0 0)",
    label: "Muted text",
  },
  // The second, dimmer text tier below `mutedForeground`: hints, placeholders,
  // at-rest glyphs that should recede until pointed at.
  faintForeground: {
    default: "oklch(0.7 0 0)",
    darkDefault: "oklch(0.48 0 0)",
    label: "Faint text",
  },
  accent: {
    default: "oklch(0.97 0 0)",
    darkDefault: "oklch(0.269 0 0)",
    label: "Accent",
  },
  accentForeground: {
    default: "oklch(0.205 0 0)",
    darkDefault: "oklch(0.82 0 0)",
    label: "On accent",
  },
  destructive: {
    default: "oklch(0.577 0.245 27.325)",
    darkDefault: "oklch(0.704 0.191 22.216)",
    label: "Destructive",
  },
  destructiveForeground: {
    default: "oklch(1 0 0)",
    darkDefault: "oklch(0.985 0 0)",
    label: "Destructive text",
  },
  success: {
    default: "oklch(0.53 0.18 142)",
    darkDefault: "oklch(0.72 0.16 142)",
    label: "Success",
  },
  successForeground: {
    default: "oklch(1 0 0)",
    darkDefault: "oklch(0.145 0 0)",
    label: "Success text",
  },
  warning: {
    default: "oklch(0.72 0.17 60)",
    darkDefault: "oklch(0.78 0.14 60)",
    label: "Warning",
  },
  warningForeground: {
    default: "oklch(0.145 0 0)",
    darkDefault: "oklch(0.145 0 0)",
    label: "Warning text",
  },
  info: {
    default: "oklch(0.54 0.16 232)",
    darkDefault: "oklch(0.72 0.14 232)",
    label: "Info",
  },
  infoForeground: {
    default: "oklch(1 0 0)",
    darkDefault: "oklch(0.985 0 0)",
    label: "Info text",
  },
  border: {
    default: "oklch(0.922 0 0)",
    darkDefault: "oklch(1 0 0 / 10%)",
    label: "Border",
  },
  input: {
    default: "oklch(0.922 0 0)",
    darkDefault: "oklch(1 0 0 / 15%)",
    label: "Input border",
  },
  ring: {
    default: "oklch(0.708 0 0)",
    darkDefault: "oklch(0.556 0 0)",
    label: "Focus ring",
  },
  // Role colours below default to the value (or the mix) the surface always
  // painted, so a theme that leaves them out renders exactly as before; a theme
  // sets one to restyle that role alone.
  //
  // The primary colour used AS TEXT on a surface (a link, a checked menu
  // mark), apart from `primary`, which is a FILL first (every primary button,
  // read with `primaryForeground` on it). One value cannot serve both on a dark
  // surface: a fill dark enough for a near-white label at 4.5:1 is too dark to
  // read at 4.5:1 against the surface. Default = the fill, as every text use
  // painted before; a theme with a deep primary lifts this. (The status
  // colours split the other way — they are text first, their fills are the
  // `*Solid` tokens below.)
  primaryText: {
    default: "var(--primary)",
    label: "Primary as text",
  },
  // Emphasised text above body text: a conversation pane's title.
  strongForeground: {
    default: "var(--foreground)",
    label: "Strong text",
  },
  // Quiet text between body and muted: a header chip's label, a footer pill's.
  subtleForeground: {
    default: "var(--muted-foreground)",
    label: "Subtle text",
  },
  // A selected row's fill (a tree row, a list view's active row). Default =
  // the hover fill it always shared, so a theme that leaves it out paints
  // hover and selection alike; a theme sets it to separate the two tiers.
  selected: {
    default: "var(--accent)",
    label: "Selected row",
  },
  // A selected tree row's text: its name. Default `currentColor` = the colour
  // the row's text always inherited, so a theme that leaves it out changes
  // nothing; a theme sets it to tint the selection's name (a file browser's
  // accent-blue selection).
  selectedForeground: {
    default: "currentColor",
    label: "Selected row text",
  },
  // A selected tree row's secondary cells (an aligned date / size column).
  // Default = the muted text they always wore; set apart from
  // `selectedForeground` because the two default to different tiers.
  selectedMetaForeground: {
    default: "var(--muted-foreground)",
    label: "Selected row meta text",
  },
  // A tree's indent guides (`TreeListProps.guides`): the hairline per
  // ancestor level. Default = the border colour; a theme sets a softer rule.
  treeGuide: {
    default: "var(--border)",
    label: "Tree indent guide",
  },
  // A quiet group head's text (`SectionHeaderRow`'s `group` form, a control
  // panel's group heading). Default = the muted text it always wore.
  groupForeground: {
    default: "var(--muted-foreground)",
    label: "Group heading text",
  },
  // A floating panel's outline (popover / dropdown / select content, drawn as
  // a 1px ring). Default = the 10% foreground ring it always drew.
  popoverBorder: {
    default: "color-mix(in oklab, var(--foreground) 10%, transparent)",
    label: "Popover border",
  },
  // A highlighted row's fill INSIDE a floating panel (a menu row under the
  // pointer or arrow keys) — the overlay surface's own hover, the way the
  // sidebar has `sidebarAccent`. Default = the selected-row fill it always
  // shared, so a theme that leaves it out changes nothing; a theme whose
  // popover sits a step above its cards sets it a step above the popover,
  // without moving the selected rows of its lists and trees.
  popoverHover: {
    default: "var(--selected)",
    label: "Popover row hover",
  },
  // A text field's fill (Input, Textarea, SearchInput); its outline is
  // `input`. Default = the fill it always wore.
  field: {
    default: "transparent",
    darkDefault: "color-mix(in oklab, var(--input) 30%, transparent)",
    label: "Field fill",
  },
  // A text field's fill and outline INSIDE a floating panel (a menu's search
  // row, a picker's filter). Default = the canvas field, so a theme that
  // leaves them out changes nothing; a theme whose popover sits a step above
  // its cards sets the fill a step below the popover — a sunken well that
  // reads as the menu's first row, not a separate control.
  popoverField: {
    default: "var(--field)",
    label: "Popover field fill",
  },
  popoverFieldBorder: {
    default: "var(--input)",
    label: "Popover field border",
  },
  // A neutral header chip's fill (a conversation's model chip).
  chip: {
    default: "var(--muted)",
    label: "Chip",
  },
  // The user's message card in a conversation thread.
  messageCard: {
    default: "var(--background)",
    label: "Message card",
  },
  messageCardBorder: {
    default: "color-mix(in oklab, var(--border) 60%, transparent)",
    label: "Message card border",
  },
  // The "solid" fill role: the fill a small saturated status control wears at
  // rest, with light text on it (a filled Reload pill, the bell's badge, a
  // failed build's dot). Kept apart from `info` / `destructive` / `warning` / `success`,
  // which double as TEXT colours — a theme can deepen the fill (the app
  // chrome's navy, oxblood and deep amber) without making every status label
  // on the same surface unreadable. Default = the status colour itself, so a theme that leaves
  // them out paints exactly as before.
  infoSolid: {
    default: "var(--info)",
    label: "Info fill",
  },
  infoSolidForeground: {
    default: "var(--info-foreground)",
    label: "On info fill",
  },
  destructiveSolid: {
    default: "var(--destructive)",
    label: "Destructive fill",
  },
  destructiveSolidForeground: {
    default: "var(--destructive-foreground)",
    label: "On destructive fill",
  },
  warningSolid: {
    default: "var(--warning)",
    label: "Warning fill",
  },
  warningSolidForeground: {
    default: "var(--warning-foreground)",
    label: "On warning fill",
  },
  successSolid: {
    default: "var(--success)",
    label: "Success fill",
  },
  successSolidForeground: {
    default: "var(--success-foreground)",
    label: "On success fill",
  },
  // A collapsible transcript card: a tool call, a thinking block, a hook row.
  threadCard: {
    default: "color-mix(in oklab, var(--muted) 20%, transparent)",
    label: "Thread card",
  },
  threadCardBorder: {
    default: "color-mix(in oklab, var(--border) 50%, transparent)",
    label: "Thread card border",
  },
  // A prompt box's fill (the text editor): transparent in light mode, a faint
  // wash of the input colour in dark mode.
  composer: {
    default: "transparent",
    darkDefault: "color-mix(in oklab, var(--input) 30%, transparent)",
    label: "Composer",
  },
  // An `outline` Button's hairline and fill (the prompt's split template
  // chips, among others).
  outlineBorder: {
    default: "var(--border)",
    darkDefault: "var(--input)",
    label: "Outline control border",
  },
  outlineFill: {
    default: "var(--background)",
    darkDefault: "color-mix(in oklab, var(--input) 30%, transparent)",
    label: "Outline control fill",
  },
  // An `outline` Button's hovered fill and label. Its own token, not `muted`:
  // a theme whose `outlineFill` IS its muted tone (Mist) would otherwise hover
  // to the colour it already wears.
  outlineHover: {
    default: "var(--muted)",
    darkDefault: "color-mix(in oklab, var(--input) 50%, transparent)",
    label: "Outline control hover",
  },
  outlineHoverForeground: {
    default: "var(--foreground)",
    label: "Outline control hover text",
  },
  // The inline-code chip's hairline (only drawn where a theme gives the chip a
  // border width, `borderCode` in density).
  codeBorder: {
    default: "var(--border)",
    label: "Inline code border",
  },
  // The glyphs and counters of a pane's toolbar strip, and a prompt box's own
  // icon actions (the mic). `currentColor` = the text colour they always
  // inherited.
  toolbarForeground: {
    default: "currentColor",
    label: "Toolbar icons",
  },
  // Selected TEXT: the fill behind a text selection — the browser's own
  // (`::selection`) and an editor-painted one (the page editor's cross-block
  // span, `::highlight(page-text-span)`) alike. ONE token for both, so a
  // native selection and a painted one cannot be told apart where they meet.
  // Clearly blue in both schemes — a selection must read as one at a glance,
  // which a faint primary tint over a dark background did not — and
  // translucent, so a selection over a tinted surface (a callout, a code
  // background) still shows the surface through it.
  textSelection: {
    default: "oklch(0.62 0.16 250 / 0.35)",
    darkDefault: "oklch(0.62 0.16 255 / 0.5)",
    label: "Text selection",
  },
});

export type ColorPaletteTokenValues = {
  [K in keyof typeof colorPaletteGroup.schema]: string;
};
