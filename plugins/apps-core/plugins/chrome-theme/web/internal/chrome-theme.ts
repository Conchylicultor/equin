import { both, defineFixedTheme } from "@plugins/ui/plugins/theme-engine/core";
import { fixedThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";

// The graphite tone: a neutral, faintly cool near-black that hosts light and
// dark apps alike. The chrome owns no accent colour of its own — the only
// accent on screen belongs to the app in the surface — so every tone below is
// grey except the status colours.
const GROUND = "oklch(0.2303 0.0083 264.40)"; // the rail and the tab bar
const PANEL = "oklch(0.2718 0.0102 260.70)"; // a card: one step off the ground
const TEXT = "oklch(0.8910 0.0059 264.53)";
const DIM = "oklch(0.6493 0.0128 264.48)"; // idle icons, inactive tabs
const HAIRLINE = "oklch(0.3126 0.0115 264.39)";
const HOVER = "oklch(0.2882 0.0062 258.36)"; // 6% white over the ground
const ACTIVE = "oklch(0.3321 0.0060 258.35)"; // 11% white over the ground
const SIGNAL = "oklch(0.7005 0.1387 252.57)"; // the build spinner, focus ring
const ALERT = "oklch(0.6256 0.1933 23.03)"; // error text, danger rows
const OK = "oklch(0.7278 0.1698 151.06)"; // the health dot
const INK = "oklch(0.2303 0.0083 264.40)"; // text on a signal/ok fill
// The solid fills: deep navy, oxblood and amber a small status control wears
// at rest (the filled Reload pill, the bell's badge, a failed build's dot and
// frame, the broken activity ring), with white text on them. Kept apart from
// SIGNAL / ALERT / the warning text tone, which stay bright because ~20 chrome
// surfaces also use `info` / `destructive` / `warning` as TEXT on the graphite
// panel — at these depths (≈1.5:1 against the bar) every such label would go
// unreadable.
const NAVY = "oklch(0.3640 0.1185 259.14)"; // #113b7b
const OXBLOOD = "oklch(0.3629 0.1265 23.27)"; // #72151b
const AMBER = "oklch(0.4500 0.1000 65.00)"; // #7a4702 — white on it ≈7.6:1
const WHITE = "oklch(1 0 0)";
// A text field sunk into a panel: a shade darker than the panel it sits in
// (22% black over it), so the box you type in reads as a well rather than as
// another raised card.
const WELL = "oklch(0 0 0 / 0.22)";
// A popover opened from the chrome is the chrome: the bar's own ground (opaque —
// the bar's glass blur would cost legibility over a busy app), the floating
// bar's ring (the text at 9%) and its hover (the text at 8%, a tint rather than
// an opaque step, so it reads the same over any fill inside the panel).
const POPOVER_RING = "color-mix(in oklab, var(--foreground) 9%, transparent)";
const POPOVER_HOVER = "color-mix(in oklab, var(--foreground) 8%, transparent)";
// The chrome's floating tier, worn by the floating bar's glass capsule and by
// every popover opened from the chrome, so the panel lifts off the app exactly
// as the bar it hangs from does.
const FLOATING_SHADOW =
  "0 10px 30px -8px oklch(0 0 0 / 0.6), 0 2px 6px 0px oklch(0 0 0 / 0.35)";

/**
 * The app chrome's theme — the rail, the tab strip, the action bar and the
 * toasts, plus every popover opened from them. A fixed theme: it is the same
 * whichever app is focused and whether the page is light or dark, so an app
 * with its own look is framed by the same neutral frame as every other one.
 *
 * Beyond colours it names only what makes it read as quiet chrome: its two
 * heights, lighter control labels (12.5px, regular — a tab's title and a
 * button's label alike), font smoothing that draws light text at the font's
 * own weight, and Lucide icons. The font, the rest of the type scale, radii
 * and spacing are the defaults every app uses, so the chrome is set in the
 * same face as the apps it hosts.
 */
export const chromeTheme = defineFixedTheme({
  id: "chrome",
  label: "Chrome",
  scheme: "dark",
  fragments: [
    colorPaletteGroup.fragment(
      both({
        background: GROUND,
        foreground: TEXT,
        card: PANEL,
        cardForeground: TEXT,
        popover: GROUND,
        popoverForeground: TEXT,
        popoverBorder: POPOVER_RING,
        popoverHover: POPOVER_HOVER,
        secondary: ACTIVE,
        secondaryForeground: TEXT,
        muted: HOVER,
        mutedForeground: DIM,
        accent: ACTIVE,
        accentForeground: TEXT,
        destructive: ALERT,
        destructiveForeground: WHITE,
        destructiveSolid: OXBLOOD,
        destructiveSolidForeground: WHITE,
        success: OK,
        successForeground: INK,
        info: SIGNAL,
        infoForeground: INK,
        infoSolid: NAVY,
        infoSolidForeground: WHITE,
        warningSolid: AMBER,
        warningSolidForeground: WHITE,
        border: HAIRLINE,
        input: HAIRLINE,
        ring: SIGNAL,
        // The chrome's one accent is its signal blue, so a primary action in a
        // chrome popover (Improve's Create task) lights in it rather than in
        // the default palette's darker primary, which read as a dim blue on the graphite.
        primary: SIGNAL,
        primaryForeground: INK,
        composer: WELL,
      }),
    ),
    sidebarPaletteGroup.fragment(
      both({
        sidebar: GROUND,
        sidebarForeground: TEXT,
        sidebarBorder: HAIRLINE,
        // The hover step — a ghost control on the chrome hovers to this
        // (the chrome surface publishes it as `--hover-fill`). The selected
        // app and tab sit one step further, on `accent`.
        sidebarAccent: HOVER,
        sidebarAccentForeground: TEXT,
      }),
    ),
    densityGroup.fragment(
      both({
        // A 36px bar holding 26px controls.
        chromeBarH: "2.25rem",
        controlHeightSm: "1.625rem",
        // The md control (the floating bar's 32px buttons, a chrome popover's
        // actions) draws an 18px icon box with a 7px label gap: a Lucide glyph
        // fills 7/8 of its box, so 18px is the 16px glyph the bar is designed
        // around (stroke 1.2px either way — Lucide's stroke does not scale).
        controlIconMd: "1.125rem",
        controlGapMd: "0.4375rem",
      }),
    ),
    typeScaleGroup.fragment(
      both({
        fontSizeControl: "0.78125rem",
        fontWeightControl: "400",
        // The chrome's count chips (the bell's unread badge): 9.5px figures on
        // a 16px line, set a step heavier than semibold so they hold up white
        // on a deep fill at that size.
        fontSizeTagCompact: "0.59375rem",
        lineHeightTagCompact: "1rem",
        fontWeightTagStrong: "650",
      }),
    ),
    fontFamilyGroup.fragment(both({ fontSmoothing: "antialiased" })),
    // A pill's rounded ends take 2px more than a rectangle's sides: the
    // Improve pill's outer end sits 12px from its sparkle, its joined end 10px.
    // A popover's corners are 14px: rounder than an app's panels, closer to
    // the capsule it opens from.
    shapeGroup.fragment(
      both({ pillPadExtra: "0.125rem", radiusPopover: "0.875rem" }),
    ),
    // The chrome's floating tier: a bar that floats over arbitrary app content
    // (the fullscreen action bar's glass capsule) casts a deep, soft shadow so
    // it lifts off light and dark apps alike — and so does every popover
    // opened from the chrome.
    shadowGroup.fragment(
      both({
        "shadow-2xl": FLOATING_SHADOW,
        "shadow-popover": FLOATING_SHADOW,
      }),
    ),
    // The chrome draws Lucide: every `symbol("…")` on the rail, the tab bar,
    // the action bar and their popovers draws its Lucide counterpart — thin,
    // even strokes that sit quietly on the graphite. A symbol with no Lucide
    // counterpart keeps its Material drawing (outline, filled when active).
    iconsGroup.fragment(both({ iconFamily: "lucide" })),
  ],
});

/** The scope token every chrome surface wears: `<Theme name={chromeThemeScope}>`. */
export const chromeThemeScope = fixedThemeScope(chromeTheme);
