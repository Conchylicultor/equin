import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { sidebarMetricsGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-metrics/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { scrollbarGroup } from "@plugins/ui/plugins/tokens/plugins/scrollbar/core";

/**
 * Mist, the agent manager's look (prototype proto-1789643584-ldt6): cool,
 * lifted slate surfaces, three deep action fills — lagoon blue (primary: Send,
 * Push & Close), ember (Stop) and pine (Go) — and no colour beyond what the
 * theme has a slot for: selection, hover and focus are neutral greys.
 *
 * Each fill is deep enough for a near-white label at ~6:1. Too deep to read as
 * text on the slate, so links read `primaryText`, and Stop / Go take the
 * `*Solid` fills — the status colours (error text, running / done dots, green
 * badges) keep Mist's bright coral and mint.
 *
 * The surface ramp, darkest first: the page (`background`), the sidebar and
 * cards one step up, then the quiet fill every hover, chip, pill and selected
 * row shares — and menus and popovers, which float on it.
 */
const DARK = {
  page: "oklch(0.195 0.012 248)",
  panel: "oklch(0.225 0.013 246)",
  fill: "oklch(0.265 0.015 244)",
  // One step past the fill: a hovered outlined control.
  fillHover: "oklch(0.305 0.017 242)",
  // Soft, not white: the app's usual 0.82 text lightness, tinted to the slate.
  text: "oklch(0.82 0.008 240)",
  // The emphasised tier, near white: the selected row, the active nav item,
  // the brand and the model picker.
  textStrong: "oklch(0.95 0.005 240)",
  // The secondary text tier: nav labels, sidebar text.
  text2: "oklch(0.8 0.012 238)",
  mutedText: "oklch(0.66 0.014 238)",
  faintText: "oklch(0.52 0.014 240)",
  // Lagoon (#246181): the primary fill, a near-white label on it at ~6:1;
  // lifted for text.
  lagoon: "oklch(0.468 0.081 235)",
  lagoonInk: "oklch(0.96 0.012 235)",
  lagoonText: "oklch(0.74 0.1 235)",
  // Ember (#8a4a33) and pine: the Stop and Go fills, on lagoon's terms.
  ember: "oklch(0.482 0.094 40)",
  emberInk: "oklch(0.96 0.012 40)",
  pine: "oklch(0.475 0.085 155)",
  pineInk: "oklch(0.96 0.012 155)",
  // One hairline for every border; the prompt field's outline one step firmer.
  border: "oklch(0.33 0.018 244 / 0.45)",
  input: "oklch(0.35 0.02 244 / 0.7)",
  // Focus is grey, never the accent: the prompt field and every control ring in it.
  ring: "oklch(0.66 0.014 238)",
};

/** A readable light inversion: Mist is designed dark, but a theme resolves in both modes. */
const LIGHT = {
  page: "oklch(0.985 0.003 240)",
  panel: "oklch(0.965 0.005 240)",
  fill: "oklch(0.93 0.008 240)",
  fillHover: "oklch(0.89 0.01 240)",
  text: "oklch(0.2 0.015 245)",
  textStrong: "oklch(0.13 0.015 245)",
  text2: "oklch(0.32 0.015 242)",
  mutedText: "oklch(0.48 0.014 240)",
  faintText: "oklch(0.62 0.012 240)",
  lagoon: "oklch(0.5 0.1 235)",
  lagoonInk: "oklch(0.99 0 0)",
  lagoonText: "oklch(0.48 0.1 235)",
  ember: "oklch(0.52 0.12 38)",
  emberInk: "oklch(0.99 0 0)",
  pine: "oklch(0.5 0.1 155)",
  pineInk: "oklch(0.99 0 0)",
  border: "oklch(0.25 0.02 244 / 0.1)",
  input: "oklch(0.25 0.02 244 / 0.2)",
  ring: "oklch(0.48 0.014 240)",
};

const colorPalette = colorPaletteGroup.fragment({
  dark: {
    background: DARK.page,
    foreground: DARK.text,
    card: DARK.panel,
    cardForeground: DARK.text,
    // Menus and popovers float one step above the cards they open over (the
    // fill), edged by the firm outline, and a row under the pointer or arrow
    // keys lifts one step past that — the Menu prototype's bg-2 → bg-3. Its
    // own hover token, so the selected rows of lists keep the fill.
    popover: DARK.fill,
    popoverForeground: DARK.text,
    popoverHover: DARK.fillHover,
    popoverBorder: DARK.input,
    // A field inside one (the menu's search row) sinks a step below it, to
    // the panel tone, edged by the soft hairline — the Menu prototype's bg-1.
    popoverField: DARK.panel,
    popoverFieldBorder: DARK.border,
    primary: DARK.lagoon,
    primaryForeground: DARK.lagoonInk,
    primaryText: DARK.lagoonText,
    secondary: DARK.fill,
    secondaryForeground: DARK.text,
    muted: DARK.fill,
    mutedForeground: DARK.mutedText,
    faintForeground: DARK.faintText,
    accent: DARK.fill,
    // A selected row's label reads brighter than its neighbours'.
    accentForeground: DARK.textStrong,
    // Coral, green, amber and periwinkle — Mist's status colours.
    destructive: "oklch(0.74 0.11 28)",
    destructiveForeground: "oklch(0.985 0 0)",
    success: "oklch(0.8 0.11 158)",
    successForeground: "oklch(0.2 0.03 158)",
    destructiveSolid: DARK.ember,
    destructiveSolidForeground: DARK.emberInk,
    successSolid: DARK.pine,
    successSolidForeground: DARK.pineInk,
    warning: "oklch(0.82 0.12 82)",
    warningForeground: "oklch(0.2 0.03 82)",
    info: "oklch(0.76 0.1 244)",
    infoForeground: "oklch(0.2 0.03 244)",
    border: DARK.border,
    input: DARK.input,
    ring: DARK.ring,
    // The main pane's roles. Only the conversation title takes the strong
    // step; header chips and footer pills sit on the secondary one.
    strongForeground: DARK.textStrong,
    subtleForeground: DARK.text2,
    // Thread cards, header chips and the prompt box sit one step up on the
    // panel tone, edged by the one hairline; outlined controls (the prompt's
    // split template chips) fill with the hover tone and hover one step past
    // it, the label brightening to the strong tier — the mockup's bg-2 → bg-3.
    chip: DARK.panel,
    messageCard: DARK.panel,
    messageCardBorder: DARK.border,
    threadCard: DARK.panel,
    threadCardBorder: DARK.border,
    composer: DARK.panel,
    outlineBorder: DARK.border,
    outlineFill: DARK.fill,
    outlineHover: DARK.fillHover,
    outlineHoverForeground: DARK.textStrong,
    codeBorder: DARK.border,
    // Toolbar glyphs and counters recede; hover brings them to full text.
    toolbarForeground: DARK.mutedText,
  },
  light: {
    background: LIGHT.page,
    foreground: LIGHT.text,
    card: "oklch(1 0 0)",
    cardForeground: LIGHT.text,
    popover: "oklch(1 0 0)",
    popoverForeground: LIGHT.text,
    popoverField: LIGHT.panel,
    popoverFieldBorder: LIGHT.border,
    primary: LIGHT.lagoon,
    primaryForeground: LIGHT.lagoonInk,
    primaryText: LIGHT.lagoonText,
    secondary: LIGHT.fill,
    secondaryForeground: LIGHT.text,
    muted: LIGHT.fill,
    mutedForeground: LIGHT.mutedText,
    faintForeground: LIGHT.faintText,
    accent: LIGHT.fill,
    accentForeground: LIGHT.textStrong,
    destructive: "oklch(0.6 0.16 28)",
    destructiveForeground: "oklch(0.99 0 0)",
    success: "oklch(0.55 0.13 158)",
    successForeground: "oklch(0.99 0 0)",
    destructiveSolid: LIGHT.ember,
    destructiveSolidForeground: LIGHT.emberInk,
    successSolid: LIGHT.pine,
    successSolidForeground: LIGHT.pineInk,
    warning: "oklch(0.7 0.14 70)",
    warningForeground: "oklch(0.2 0.03 70)",
    info: "oklch(0.55 0.12 244)",
    infoForeground: "oklch(0.99 0 0)",
    border: LIGHT.border,
    input: LIGHT.input,
    ring: LIGHT.ring,
    strongForeground: LIGHT.textStrong,
    subtleForeground: LIGHT.text2,
    chip: LIGHT.panel,
    messageCard: LIGHT.panel,
    messageCardBorder: LIGHT.border,
    threadCard: LIGHT.panel,
    threadCardBorder: LIGHT.border,
    composer: LIGHT.panel,
    outlineBorder: LIGHT.border,
    outlineFill: LIGHT.fill,
    outlineHover: LIGHT.fillHover,
    outlineHoverForeground: LIGHT.textStrong,
    codeBorder: LIGHT.border,
    toolbarForeground: LIGHT.mutedText,
  },
});

/**
 * The sidebar sits one step above the page. Its active nav item is the same
 * neutral fill as a hovered or selected row, with the emphasised text (as are
 * the brand and the model picker); nav icons at rest are muted.
 */
const sidebarPalette = sidebarPaletteGroup.fragment({
  dark: {
    sidebar: DARK.panel,
    sidebarForeground: DARK.text2,
    sidebarPrimary: DARK.lagoon,
    sidebarPrimaryForeground: DARK.lagoonInk,
    sidebarBorder: DARK.border,
    sidebarAccent: DARK.fill,
    sidebarAccentForeground: DARK.textStrong,
    sidebarIcon: DARK.mutedText,
    sidebarRing: DARK.ring,
  },
  light: {
    sidebar: LIGHT.panel,
    sidebarForeground: LIGHT.text2,
    sidebarPrimary: LIGHT.lagoon,
    sidebarPrimaryForeground: LIGHT.lagoonInk,
    sidebarBorder: LIGHT.border,
    sidebarAccent: LIGHT.fill,
    sidebarAccentForeground: LIGHT.textStrong,
    sidebarIcon: LIGHT.mutedText,
    sidebarRing: LIGHT.ring,
  },
});

/**
 * Inter for text (the bundled face, stated so it stays true) and JetBrains Mono
 * for code, drawn `antialiased` as the mockup is: `auto` lets macOS thicken the
 * stems, which on Mist's dark slate reads a weight heavier than the mockup.
 */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Inter Variable', sans-serif",
    fontMono: "'JetBrains Mono', monospace",
    fontSmoothing: "antialiased",
  }),
);

/**
 * Softer corners: rows and small controls (`rounded-md`, 0.8×) land on Mist's
 * 9px, and so do the `md` / `lg` buttons and button-group segments
 * (`radiusControl`). Raised cards — the thread's user message, tool rows and
 * prompt box — take the mockup's 12px (`radiusCard`). A tool badge is an 8px
 * box edged in its own colour, an inline code span a 7px bordered chip. A
 * menu or control-panel row — and the search field that leads a menu — takes
 * the Menu prototype's 7px (`radiusPanelRow`), tighter than the 9px rows
 * elsewhere.
 */
const shape = shapeGroup.fragment(
  both({
    radius: "0.7rem",
    radiusControl: "0.5625rem",
    radiusCard: "0.75rem",
    radiusToolBadge: "0.5rem",
    borderToolBadge: "1px",
    radiusCode: "0.4375rem",
    borderCode: "1px",
    radiusPanelRow: "0.4375rem",
  }),
);

/**
 * The mockup's sidebar geometry: a 264px panel, 32px nav rows padded 9px, and
 * 15px icons with an 11px gap to the label. The label itself is the `label`
 * role (13px medium, see `typeScale`), shared with the conversation rows.
 */
const sidebarMetrics = sidebarMetricsGroup.fragment(
  both({
    sidebarPanelWidth: "16.5rem",
    sidebarRowHeight: "2rem",
    sidebarRowPadX: "0.5625rem",
    sidebarIconSize: "0.9375rem",
    sidebarIconGap: "0.6875rem",
  }),
);

/**
 * 7px status dots at the `md` tier (the sidebar's conversation rows and model
 * picker), and a tighter compact chip — 1px × 4px padding, 6px corners — for a
 * row's count chip.
 *
 * The control ladder, from the mockup's main pane: `xs` is the footer pill
 * (25px, 10px padding, 12px icons), `sm` the toolbar button (26px, 7px padding,
 * 13px icons), `md` the primary Stop / Restore button (29px, 14px padding).
 *
 * The main pane's geometry: a 45px title bar inset 8px before its sidebar
 * toggle and 16px after its last chip, a toolbar strip inset 14px, header chips
 * padded 4px × 11px (a 25px pill), thread cards padded 10px × 13px, a prompt
 * box padded 10px 13px 9px around unpadded text with 8px before its action
 * row, a 9px × 3px tool badge, 6px × 1.5px inline code, a 26px split arrow
 * (6px either side of its 12px glyph) and an 11px op-status glyph.
 */
const density = densityGroup.fragment(
  both({
    statusDotMd: "0.4375rem",
    padChipCompactX: "0.25rem",
    padChipCompactY: "0.0625rem",
    radiusChipCompact: "0.375rem",
    controlHeightXs: "1.5625rem",
    controlHeightSm: "1.625rem",
    controlHeightMd: "1.8125rem",
    controlPadXs: "0.625rem",
    controlPadSm: "0.4375rem",
    controlPadMd: "0.875rem",
    controlIconXs: "0.75rem",
    controlIconSm: "0.8125rem",
    controlIconMd: "0.8125rem",
    chromePaneH: "2.8125rem",
    chromePanePadStart: "0.5rem",
    chromePanePadEnd: "1rem",
    subpanePadX: "0.875rem",
    padChipHeaderX: "0.6875rem",
    padChipHeaderY: "0.25rem",
    padThreadCardX: "0.8125rem",
    padThreadCardY: "0.625rem",
    padComposer: "0.625rem 0.8125rem 0.5625rem",
    padComposerText: "0 0 0.5rem",
    padComposerActions: "0",
    padToolBadgeX: "0.5625rem",
    padToolBadgeY: "0.1875rem",
    padCodeX: "0.375rem",
    padCodeY: "0.09375rem",
    padSplitArrowX: "0.375rem",
    opStatusIcon: "0.6875rem",
  }),
);

/**
 * The mockup's type (prototype proto-1789643584-ldt6, option `mist-text=roles`
 * — Inter at Mist's own sizes), set as roles only, never component tokens. The
 * ladder, smallest first:
 *
 * - 10.5px semibold `tag-compact` (a row's count chip, on a 15px line);
 * - 11px `2xs` (relative times, counts) — the default rung, not set here;
 * - 11.5px semibold `tag` (header chips, the tool badge), bold when strong;
 * - 12px `caption` and `control` (buttons, tabs, footer pills), semibold — the
 *   primary action too: a bold near-white label on a filled button read heavy;
 * - 12.5px `code` on a 19px line (inline and block code);
 * - 12.5px semibold `group` on a 17.5px line (the sidebar's quiet group
 *   headings, "Queue 14" — the mock's 1.4 line at that size);
 * - 13px `label` and base on a 1.4 line (the sidebar, section heads, inherited
 *   text — the base is set on the app's scope root, never on `html`);
 * - 13.5px `body` on a 19px line (messages, the prompt);
 * - 26px semibold `display` on a 32px line (the home's greeting — prototype
 *   proto-1791387390-fyca; the app's one headline, so no other surface moves).
 */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBase: "0.8125rem",
    lineHeightBase: "1.4",
    // The thread keeps the column it had at 16px (75ch of Inter, 757px), the
    // mockup's width, rather than shrinking with the smaller base font.
    measureReading: "47.3125rem",
    fontSizeBody: "0.84375rem",
    lineHeightBody: "1.1875rem",
    lineHeightLabel: "1.1375rem",
    fontSizeControl: "0.75rem",
    fontWeightControl: "600",
    fontWeightControlStrong: "600",
    fontSizeTag: "0.71875rem",
    lineHeightTag: "0.9375rem",
    fontWeightTag: "600",
    fontWeightTagStrong: "700",
    fontSizeTagCompact: "0.65625rem",
    lineHeightTagCompact: "0.9375rem",
    fontSizeCode: "0.78125rem",
    lineHeightCode: "1.1875rem",
    fontSizeGroup: "0.78125rem",
    lineHeightGroup: "1.09375rem",
    fontSizeDisplay: "1.625rem",
    lineHeightDisplay: "2rem",
    fontWeightDisplay: "600",
  }),
);

/**
 * The mockup's scrollbar thumb (a tone one step past the hover fill) on
 * Chromium's native overlay bar, over a transparent track — so no rail
 * appears behind the thumb while it is hovered.
 */
const scrollbar = scrollbarGroup.fragment({
  dark: { scrollbarColor: "oklch(0.305 0.017 242) transparent" },
  light: { scrollbarColor: "oklch(0.87 0.01 240) transparent" },
});

/**
 * The agent manager's own theme. Selected for the app in
 * `config/ui/theme-engine/@app/agent-manager/theme.jsonc`; a group it does not
 * mention paints that group's schema defaults, never the desktop's choice.
 */
export const mistTheme = defineTheme({
  id: "mist",
  label: "Mist",
  fragments: [
    colorPalette,
    sidebarPalette,
    sidebarMetrics,
    density,
    typeScale,
    fontFamily,
    shape,
    scrollbar,
  ],
});
