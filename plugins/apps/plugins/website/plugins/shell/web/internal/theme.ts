import {
  defineSubTheme,
  defineTheme,
  both,
} from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { chartGroup } from "@plugins/ui/plugins/tokens/plugins/chart/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";

/** Azure accent and cyan counter-accent, shared by both modes. */
const AZURE = "oklch(0.5461 0.2152 262.88)";
const CYAN = "oklch(0.7971 0.1339 211.53)";
const WHITE = "oklch(1 0 0)";
const BLACK = "oklch(0 0 0)";

const colorPalette = colorPaletteGroup.fragment({
  dark: {
    // Near-black, faintly blue: the page.
    background: "oklch(0.1398 0.0117 265.76)",
    foreground: "oklch(0.9674 0.0013 286.38)",
    // The card and popover panel — one step off the page.
    card: "oklch(0.1814 0.0158 261.54)",
    cardForeground: "oklch(0.9674 0.0013 286.38)",
    popover: "oklch(0.1814 0.0158 261.54)",
    popoverForeground: "oklch(0.9674 0.0013 286.38)",
    // The brand colour: the wordmark's full stop, the headline gradient, the
    // property dots, every hover.
    primary: AZURE,
    primaryForeground: WHITE,
    // The filled control is the FOREGROUND, inverted — a white pill with black
    // type — not the accent. `secondary` carries that inverted fill so the
    // accent stays the thing you act on.
    secondary: "oklch(0.9674 0.0013 286.38)",
    secondaryForeground: BLACK,
    muted: "oklch(0.22 0.02 262)",
    // The secondary text tier — a lede, a card's paragraph, a nav link.
    mutedForeground: "oklch(0.7727 0.0127 286.10)",
    // The third tier — a card's category line, a group's line, small print.
    faintForeground: "oklch(0.552 0.016 285.94)",
    accent: "oklch(0.22 0.02 262)",
    accentForeground: "oklch(0.9674 0.0013 286.38)",
    destructive: "oklch(0.704 0.191 22.216)",
    destructiveForeground: "oklch(0.985 0 0)",
    success: "oklch(0.72 0.16 142)",
    successForeground: "oklch(0.145 0 0)",
    warning: "oklch(0.78 0.14 60)",
    warningForeground: "oklch(0.145 0 0)",
    info: CYAN,
    infoForeground: BLACK,
    // Hairlines at 8% white; the ghost button's outline at 20%.
    border: "oklch(1 0 0 / 8%)",
    input: "oklch(1 0 0 / 20%)",
    ring: AZURE,
  },
  light: {
    background: "oklch(0.985 0.002 265)",
    foreground: "oklch(0.16 0.012 265)",
    card: WHITE,
    cardForeground: "oklch(0.16 0.012 265)",
    popover: WHITE,
    popoverForeground: "oklch(0.16 0.012 265)",
    primary: AZURE,
    primaryForeground: WHITE,
    secondary: "oklch(0.16 0.012 265)",
    secondaryForeground: WHITE,
    muted: "oklch(0.95 0.006 265)",
    mutedForeground: "oklch(0.48 0.014 286)",
    faintForeground: "oklch(0.6 0.012 286)",
    accent: "oklch(0.95 0.006 265)",
    accentForeground: "oklch(0.16 0.012 265)",
    destructive: "oklch(0.577 0.245 27.325)",
    destructiveForeground: WHITE,
    success: "oklch(0.53 0.18 142)",
    successForeground: WHITE,
    warning: "oklch(0.72 0.17 60)",
    warningForeground: "oklch(0.145 0 0)",
    info: "oklch(0.62 0.12 211)",
    infoForeground: WHITE,
    border: "oklch(0 0 0 / 8%)",
    input: "oklch(0 0 0 / 20%)",
    ring: AZURE,
  },
});

/**
 * The chart ramp starts at the site's cyan counter-accent — the far end of the
 * headline gradient reads `--chart-1` — and walks
 * toward the azure.
 */
const chart = chartGroup.fragment({
  dark: {
    "chart-1": CYAN,
    "chart-2": "oklch(0.70 0.15 235)",
    "chart-3": AZURE,
    "chart-4": "oklch(0.48 0.19 265)",
    "chart-5": "oklch(0.42 0.16 268)",
  },
  light: {
    "chart-1": "oklch(0.62 0.12 211)",
    "chart-2": "oklch(0.58 0.15 235)",
    "chart-3": AZURE,
    "chart-4": "oklch(0.48 0.19 265)",
    "chart-5": "oklch(0.42 0.16 268)",
  },
});

/**
 * The site's typeface: Inter, the bundled variable face, with the default serif
 * and mono stacks and no tracking.
 *
 * Stated even though it equals the font-family group's schema defaults: the
 * site's design depends on it, and saying so here keeps it true if those
 * defaults ever move.
 */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Inter Variable', sans-serif",
    fontSerif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    fontMono: "'Cascadia Code Variable', monospace",
    letterSpacing: "0em",
  }),
);

/**
 * The site's type scale. Every role is sized for a page read at arm's length,
 * not for chrome: the display rung is the 78px headline, body is 15.5px on a
 * 1.6 line, and captions are the 12px eyebrow.
 *
 * Line heights are lengths (the group's contract), each the role's size × its
 * designed ratio — 1.02 for the headline, 1.15 for a section title, 1.6 for
 * running text.
 */
const typeScale = typeScaleGroup.fragment(
  both({
    "font-size-2xs": "0.6875rem",
    "font-size-3xs": "0.625rem",
    "line-height-2xs": "1rem",
    "line-height-3xs": "0.875rem",
    fontWeightNormal: "400",
    fontWeightMedium: "500",
    fontWeightSemibold: "600",
    fontWeightBold: "700",
    // 78px / 1.02 — the one headline.
    fontSizeDisplay: "4.875rem",
    lineHeightDisplay: "4.9725rem",
    // 30px / 1.15 — a section's title ("What is equin?").
    fontSizeTitle: "1.875rem",
    lineHeightTitle: "2.15625rem",
    // 24px / 1.6 — a contact card's heading; the wordmark.
    fontSizeHeading: "1.5rem",
    lineHeightHeading: "2.4rem",
    // 19px / 1.6 — the lede and the story line.
    fontSizeSubheading: "1.1875rem",
    lineHeightSubheading: "1.9rem",
    // 15.5px / 1.6 — every card paragraph.
    fontSizeBody: "0.96875rem",
    lineHeightBody: "1.55rem",
    // 14px / 1.6 — nav links and buttons.
    fontSizeLabel: "0.875rem",
    lineHeightLabel: "1.4rem",
    // 12px / 1.6 — the eyebrow and the small print.
    fontSizeCaption: "0.75rem",
    lineHeightCaption: "1.2rem",
    // Code at the caption size on the label's line, as it has always read here.
    fontSizeCode: "0.75rem",
    lineHeightCode: "1.4rem",
  }),
);

/**
 * The site's rhythm and chrome metrics.
 *
 * The spacing ramp is retuned to the page's own component rhythm — the gap
 * between a card's eyebrow and its question, between two cards, between the
 * headline and its lede — rather than to app chrome. The control heights are the
 * two button sizes the page has (the header's pill, the contact cards' buttons),
 * and the pane-header height is the site header's 72px.
 *
 * `chromePadX` and `documentPadX` (the pane edge, which the site header — a
 * pane header — pads by) are one gutter computed from the site's reading
 * measure, so the wordmark and the nav land on the same left and right edges
 * as every band below them — the one number that must agree with
 * `WebsiteBand`, so both read `--website-measure` (see `website-band.css`).
 */
const density = densityGroup.fragment(
  both({
    padChipX: "0.375rem",
    padChipY: "0.125rem",
    padRowX: "0.5rem",
    padRowY: "0.375rem",
    // 34px — a card's inset.
    padCard: "2.125rem",
    controlHeightXs: "1.5rem",
    // 38.4px — the header's call-to-action pill (14px on a 1.6 line + 8px × 2).
    controlHeightSm: "2.4rem",
    // 44.4px — a contact card's button (14px on a 1.6 line + 11px × 2).
    controlHeightMd: "2.775rem",
    controlHeightLg: "3rem",
    // 12px — a small control's inline padding: the quiet nav links. The
    // call-to-action pill adds the shape's pill extra on top (see `shape`).
    controlPadSm: "0.75rem",
    chromeBarH: "3rem",
    // 72px — the site header.
    chromePaneH: "4.5rem",
    chromePadX:
      "max(var(--space-2xl), calc((100% - var(--website-measure)) / 2))",
    documentPadX: "var(--chrome-pad-x)",
    "space-2xs": "0.125rem",
    // 4px — between two nav items.
    "space-xs": "0.25rem",
    // 10px — a dot and its label; a contact heading and its line.
    "space-sm": "0.625rem",
    // 14px — a question and its paragraph.
    "space-md": "0.875rem",
    // 20px — between two cards.
    "space-lg": "1.25rem",
    // 24px — a paragraph and its button; an eyebrow and its question.
    "space-xl": "1.5rem",
    // 28px — the headline and its lede; the narrow-viewport gutter.
    "space-2xl": "1.75rem",
  }),
);

/**
 * One radius token sized so the card corner (`rounded-2xl`, 1.8×) lands on the
 * design's 20px; a button's `rounded-lg` (1×) then sits at 11px.
 *
 * The pill extra is what the header's call-to-action pill pads beyond the nav
 * links beside it: 12px (`controlPadSm`) + 6px = the mock's 18px, while the
 * links keep 12px, so the nav words sit the mock's ~29px apart.
 */
const shape = shapeGroup.fragment(
  both({ radius: "0.6944rem", spacing: "0.25rem", pillPadExtra: "0.375rem" }),
);

/**
 * The site's own theme — its look: palette, chart ramp and typeface. Selected
 * for the website app in `config/ui/theme-engine/@app/website/theme.jsonc`.
 *
 * The public site is a designed thing, so it does not follow whatever the
 * desktop is set to. Every website component reads semantic tokens, so the one
 * place a colour is spelled is this file. A group the theme does not mention
 * paints that group's schema defaults — never another scope's setting. That
 * includes the sizes: everything the app shows OUTSIDE its pages (the Improve
 * panel and every other popup, the tab bar and rail while the site is focused)
 * is ordinary UI, at the standard UI sizes, in the site's colours.
 *
 * The dark values are the design. The light values are a readable inversion of
 * it — the site follows the desktop's colour mode, which is still global, and a
 * theme must resolve in both.
 */
export const equinTheme = defineTheme({
  id: "equin",
  label: "equin",
  fragments: [colorPalette, chart, fontFamily],
});

/**
 * The site's page sizes — the type scale, rhythm and corner radius a page read
 * at arm's length is designed on. Worn by every page through `WebsiteChrome`,
 * over `equinTheme`: this sets sizes only, so the colours are always the app's.
 * Popups opened from a page leave it and go back to the standard UI sizes.
 */
export const equinDocumentTheme = defineSubTheme({
  id: "equin-document",
  label: "equin document",
  fragments: [typeScale, density, shape],
});

/**
 * An inner page's heading — the sizes `WebsiteHero kind="page"` wears over
 * `equinDocumentTheme`: a 58px headline on a 1.04 line, an 18px lede on 1.55,
 * 18px between them (`space-lg`) and 34px from the lede to what the heading
 * introduces (`space-2xl`, the Apps page's search). The homepage's title page
 * keeps the document's 78px display rung: it makes the site's one claim, while
 * an inner page's heading only names the page.
 */
export const equinPageHeroTheme = defineSubTheme({
  id: "equin-page-hero",
  label: "equin page heading",
  fragments: [
    typeScaleGroup.fragment(
      both({
        fontSizeDisplay: "3.625rem",
        lineHeightDisplay: "3.77rem",
        fontSizeSubheading: "1.125rem",
        lineHeightSubheading: "1.74375rem",
      }),
    ),
    densityGroup.fragment(
      both({
        "space-lg": "1.125rem",
        "space-2xl": "2.125rem",
      }),
    ),
  ],
});
