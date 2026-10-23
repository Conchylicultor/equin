import { both, defineFixedTheme } from "@plugins/ui/plugins/theme-engine/core";
import { fixedThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";

// The onboarding prototype's palette (`proto-1792668692-5ijcs8`, its `:root`),
// by the prototype's own variable names.
const BG = "oklch(0 0 0)"; // --bg
const SURFACE_2 = "oklch(0.19 0 0)"; // --surface-2: the coach card
const LINE_2 = "oklch(1 0 0 / 0.16)"; // --line-2
const TEXT = "oklch(0.97 0 0)"; // --text
const MUTED = "oklch(0.7 0 0)"; // --muted
const FAINT = "oklch(0.52 0 0)"; // --faint
const ACCENT = "oklch(0.72 0.12 200)"; // --accent: the teal signal
const WASH = "oklch(1 0 0 / 0.06)"; // hover tint

/**
 * The onboarding hints' own theme — the tour's welcome card, coach cards,
 * spotlight and tip toasts. A fixed theme: the same in every app and in light
 * and dark, so a tour reads identically wherever it points. Black ground, a
 * 16px-cornered graphite card, pill buttons whose primary is the text colour
 * with black ink, and one teal signal (the spotlight ring, the current step,
 * the halo) held in `info` and `ring`.
 */
export const hintsTheme = defineFixedTheme({
  id: "hints",
  label: "Onboarding hints",
  scheme: "dark",
  fragments: [
    colorPaletteGroup.fragment(
      both({
        background: BG,
        foreground: TEXT,
        card: SURFACE_2,
        cardForeground: TEXT,
        popover: SURFACE_2,
        popoverForeground: TEXT,
        popoverBorder: LINE_2,
        popoverHover: WASH,
        border: LINE_2,
        input: LINE_2,
        muted: WASH,
        mutedForeground: MUTED,
        faintForeground: FAINT,
        secondary: WASH,
        secondaryForeground: TEXT,
        accent: WASH,
        accentForeground: TEXT,
        primary: TEXT,
        primaryForeground: BG,
        info: ACCENT,
        infoForeground: BG,
        ring: ACCENT,
      }),
    ),
    densityGroup.fragment(
      both({
        controlHeightSm: "2rem",
        controlPadSm: "0.8125rem",
        controlHeightLg: "2.5rem",
        controlGapSm: "0.375rem",
      }),
    ),
    typeScaleGroup.fragment(
      both({
        fontSizeBody: "0.84375rem",
        lineHeightBody: "1.265625rem",
        fontSizeSubheading: "0.96875rem",
        lineHeightSubheading: "1.4rem",
        fontSizeTitle: "1.375rem",
        lineHeightTitle: "1.75rem",
        fontSizeControl: "0.8125rem",
        lineHeightControl: "1.25rem",
        fontWeightControl: "600",
        fontSizeCaption: "0.75rem",
        lineHeightCaption: "1rem",
      }),
    ),
    fontFamilyGroup.fragment(
      both({
        fontSans: "'Geist', ui-sans-serif, system-ui, sans-serif",
        fontSmoothing: "antialiased",
      }),
    ),
    // Pills: every button size's corners are fully round.
    shapeGroup.fragment(
      both({
        radiusControl: "9999px",
        radiusControlSm: "9999px",
        radiusControlXs: "9999px",
        radiusPopover: "1rem",
        radiusCard: "1rem",
      }),
    ),
    shadowGroup.fragment(
      both({
        "shadow-popover": "0 24px 60px -16px oklch(0 0 0 / 0.9)",
      }),
    ),
    iconsGroup.fragment(both({ iconShape: "rounded" })),
  ],
});

/** The scope token every hints surface wears: `<Theme name={hintsThemeScope}>`. */
export const hintsThemeScope = fixedThemeScope(hintsTheme);
