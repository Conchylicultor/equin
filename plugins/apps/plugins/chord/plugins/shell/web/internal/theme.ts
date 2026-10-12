import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { chordPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/chord-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";

// The mockup's "onyx" palette (proto-1789461303-updb): neutral blacks, and
// off-white text that is never pure white.
const GROUND = "#080809";
const SURFACE = "#111113";
const RAISED = "#19191C";
const RULE = "#1E1E21";
const RULE_2 = "#2C2C30";
const INK = "#D6D4CF";
const INK_2 = "#979590";
const INK_3 = "#66655F";
const OK = "#62B57A";
const BAD = "#E2574C";
const GOLD = "#E8C26A";

/**
 * Surfaces and text. `primary` is the mockup's filled button — a grey (13 %
 * ink over the raised surface), not white. `accent` is the mockup's one accent,
 * gold: what marks progress and confirms a change (a started track, its
 * coverage, "from the next loop") — and, being the palette's accent, every
 * shared hover and selection fill in the app, with dark text on it. Beside it,
 * the chord colours are the only colour on the page.
 *
 * Written with `both(…)`, like every fragment here: light mode gets the same
 * dark values, which is what makes the app dark only.
 */
const colorPalette = colorPaletteGroup.fragment(
  both({
    background: GROUND,
    foreground: INK,
    card: SURFACE,
    cardForeground: INK,
    popover: RAISED,
    popoverForeground: INK,
    primary: "#323133",
    primaryForeground: INK,
    secondary: RAISED,
    secondaryForeground: INK,
    muted: RAISED,
    mutedForeground: INK_2,
    faintForeground: INK_3,
    accent: GOLD,
    accentForeground: GROUND,
    destructive: BAD,
    destructiveForeground: GROUND,
    success: OK,
    successForeground: GROUND,
    warning: "oklch(0.78 0.14 60)",
    warningForeground: GROUND,
    info: "#3AA4D0",
    infoForeground: GROUND,
    border: RULE,
    input: RULE_2,
    ring: INK_2,
  }),
);

/**
 * The chord colours ("classic"), one per numeral's number: chord-1…7 are I …
 * VII (♭VII wearing VII's), and chord-outside the neutral grey of a chord
 * with no colour (Rare). The most common chords sit on the most
 * distant hues — I orange, IV sage, V blue, vi violet — then ii gold, iii
 * rose, vii teal. The deep tile a filled answer sits on and the numeral on it
 * are derived from these in CSS (`color-mix`, `music/chord-box`), as in the
 * mockup.
 *
 * They are the palette's own defaults today; the theme states them anyway, so
 * the app keeps the mockup's look whatever the defaults become.
 */
const chordPalette = chordPaletteGroup.fragment(
  both({
    "chord-1": "#EC8A3A",
    "chord-2": "#E2B23A",
    "chord-3": "#DE6A9A",
    "chord-4": "#7FB685",
    "chord-5": "#3AA4D0",
    "chord-6": "#9C6FE6",
    "chord-7": "#2FB5A8",
    "chord-outside": "#8C8A85",
  }),
);

/**
 * Schibsted Grotesk for the text, Bodoni Moda for the chord numerals
 * (`font-serif`). Both are on Google Fonts, whose loader fetches any catalogued
 * family a theme names — no package needed. Smoothing is `antialiased`: light
 * text on a black ground otherwise renders heavier than its weight.
 */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Schibsted Grotesk', sans-serif",
    fontSerif: "'Bodoni Moda', serif",
    fontMono: "'Cascadia Code Variable', monospace",
    letterSpacing: "0em",
    fontSmoothing: "antialiased",
  }),
);

/**
 * The Chord app's own theme — dark only. Selected for the app in
 * `config/ui/theme-engine/@app/chord/theme.jsonc`. A group it does not mention
 * paints that group's schema defaults.
 */
export const chordTheme = defineTheme({
  id: "chord",
  label: "Chord",
  fragments: [colorPalette, chordPalette, fontFamily],
});
