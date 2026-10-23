import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { chordPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/chord-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";

// The immersive player's night (proto-1792113547-2qr6g7): a blue-black stage,
// warm off-white text whose quieter tiers are the same ink at lower alpha, and
// hairlines in translucent white — so every tier reads the same over the stage,
// a floating bar or a panel.
const STAGE = "#0d0d13";
const PANEL = "#111118";
const MENU = "#1b1b24";
const TEXT = "#f1efea";
const MUTED = "rgb(241 239 234 / 0.6)";
const FAINT = "rgb(241 239 234 / 0.36)";
const HAIR = "rgb(255 255 255 / 0.08)";
const HAIR_2 = "rgb(255 255 255 / 0.13)";
const CHIP = "rgb(255 255 255 / 0.06)";
const CHIP_HI = "rgb(255 255 255 / 0.11)";
const ACCENT = "#8fb8ff";
const ON_ACCENT = "#101014";
const OK = "#6fe0a0";
const WARN = "#ffc56b";
const ERR = "#ff8577";

/**
 * Surfaces and text. `primary` is the mockup's one accent, sky: the now-line,
 * the progression fill, a switch that is on. `accent` — the palette's hover and
 * selection fill — is the mockup's lighter chip (11% white), never a colour, so
 * hovering a control lifts it rather than tinting it.
 *
 * Written with `both(…)`: light mode gets the same dark values, which is what
 * makes the app dark only (light/dark is one global setting today).
 */
const colorPalette = colorPaletteGroup.fragment(
  both({
    background: STAGE,
    foreground: TEXT,
    card: PANEL,
    cardForeground: TEXT,
    popover: MENU,
    popoverForeground: TEXT,
    primary: ACCENT,
    primaryForeground: ON_ACCENT,
    secondary: CHIP,
    secondaryForeground: TEXT,
    muted: CHIP,
    mutedForeground: MUTED,
    faintForeground: FAINT,
    accent: CHIP_HI,
    accentForeground: TEXT,
    destructive: ERR,
    destructiveForeground: ON_ACCENT,
    success: OK,
    successForeground: ON_ACCENT,
    warning: WARN,
    warningForeground: ON_ACCENT,
    info: ACCENT,
    infoForeground: ON_ACCENT,
    border: HAIR,
    input: HAIR_2,
    ring: ACCENT,
    popoverBorder: HAIR_2,
    popoverHover: CHIP_HI,
    selected: CHIP_HI,
    chip: CHIP,
    field: "rgb(0 0 0 / 0.3)",
    outlineBorder: HAIR,
    outlineFill: CHIP,
    outlineHover: CHIP_HI,
  }),
);

/**
 * The chord colours, one per numeral's number (I orange … VII teal) — the
 * Chord app's palette, which every chord surface of the player paints in.
 * Stated even though they are the palette's defaults today, so the player keeps
 * the mockup's look whatever the defaults become.
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

/** Manrope for every surface, JetBrains Mono for the chord-grid source. */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Manrope', sans-serif",
    fontMono: "'JetBrains Mono', monospace",
    letterSpacing: "0em",
    fontSmoothing: "antialiased",
  }),
);

/** The mockup's type: 13px body, 12px semibold controls, a 15px song title. */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeSubheading: "0.9375rem",
    fontSizeBody: "0.8125rem",
    fontSizeLabel: "0.78125rem",
    fontSizeCaption: "0.71875rem",
    fontSizeControl: "0.75rem",
    fontWeightControl: "600",
  }),
);

/**
 * Round everything: controls are pills, floating panels 18px cards — the
 * mockup draws no square corner anywhere.
 */
const shape = shapeGroup.fragment(
  both({
    radius: "0.75rem",
    radiusCard: "0.75rem",
    radiusControl: "999px",
    radiusControlSm: "999px",
    radiusControlXs: "999px",
    radiusPopover: "18px",
    radiusPanelRow: "9px",
    // A song's cover (the library card's picture) — a 16px tile.
    radiusCover: "1rem",
    // Floating chrome (the library's toolbar cards) — pills.
    radiusFloat: "999px",
  }),
);

/**
 * A floating panel lifts well off the stage; floating chrome carries the glass
 * pill's inner top highlight; a cover sits low and rises on hover
 * (proto-1792667077-4bakda).
 */
const shadow = shadowGroup.fragment(
  both({
    "shadow-popover":
      "0 24px 60px rgb(0 0 0 / 0.55), 0 2px 8px rgb(0 0 0 / 0.3)",
    "shadow-float":
      "0 16px 44px rgb(0 0 0 / 0.42), inset 0 1px 0 rgb(255 255 255 / 0.12)",
    "shadow-cover": "0 10px 30px -14px rgb(0 0 0 / 0.7)",
    "shadow-cover-hover": "0 20px 40px -16px rgb(0 0 0 / 0.85)",
  }),
);

/**
 * Floating chrome is the mockup's glass: a dark, half-transparent fill under a
 * strong, saturated blur. (The mockup's faint white top gradient is not
 * spelled: `floatFill` is a colour token, painted as `background-color`.)
 */
const material = materialGroup.fragment(
  both({
    floatFill: "rgb(22 22 32 / 0.5)",
    floatBackdrop: "blur(16px) saturate(1.9)",
  }),
);

/**
 * The player's chrome buttons are 34px circles with 17px glyphs — the `lg`
 * rung, which the floating bars declare.
 */
const density = densityGroup.fragment(
  both({
    controlHeightLg: "2.125rem",
    controlIconLg: "1.0625rem",
    // The library gallery: 220px cards, 18px between columns, 24px between rows.
    galleryCardMin: "13.75rem",
    galleryGapX: "1.125rem",
    galleryGapY: "1.5rem",
  }),
);

/**
 * Thin-stroked line icons, as the mockup draws them: Sonata's own family
 * (`sonataIcons`, sonata/primitives/icons), which falls back to each symbol's
 * Lucide counterpart for the names it does not draw.
 */
const icons = iconsGroup.fragment(both({ iconFamily: "sonata" }));

/**
 * Sonata's own theme — the immersive player's night, dark only. Selected for
 * the app in `config/ui/theme-engine/@app/sonata/theme.jsonc`. A group it does
 * not mention paints that group's schema defaults.
 */
export const sonataTheme = defineTheme({
  id: "sonata",
  label: "Sonata",
  fragments: [
    colorPalette,
    chordPalette,
    fontFamily,
    typeScale,
    shape,
    shadow,
    material,
    density,
    icons,
  ],
});
