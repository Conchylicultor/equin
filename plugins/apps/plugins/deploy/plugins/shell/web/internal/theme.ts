import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";
import { chartGroup } from "@plugins/ui/plugins/tokens/plugins/chart/core";

// The Deploy redesign prototype's dark palette (proto-1793181461-uvir4e `:root`).
// Dark only: the Deploy app declares `colorMode: "dark"`, so the theme writes
// the same values for both modes (`both`).
const BG = "#0a0a0c";
const PANEL = "#111114";
const RAISED = "#17171b";
const HOVER = "#1d1d22";
const LINE = "#24242b";
const INK = "#ededf0";
const INK_2 = "#94949e";
const INK_3 = "#60606a";
const ACCENT = "#6d5efc";
const OK = "#3ecf8e";
const WARN = "#f5a524";
const BAD = "#f2555a";

const colorPalette = colorPaletteGroup.fragment(
  both({
    background: BG,
    foreground: INK,
    card: PANEL,
    cardForeground: INK,
    popover: PANEL,
    popoverForeground: INK,
    primary: ACCENT,
    primaryForeground: "#ffffff",
    primaryText: ACCENT,
    secondary: RAISED,
    secondaryForeground: INK,
    muted: RAISED,
    mutedForeground: INK_2,
    faintForeground: INK_3,
    accent: HOVER,
    accentForeground: INK,
    destructive: BAD,
    success: OK,
    warning: WARN,
    info: ACCENT,
    border: LINE,
    input: LINE,
    ring: ACCENT,
    switchTrack: LINE,
  }),
);

/** The sidebar sits on the page ground, split from the content by a hairline. */
const sidebarPalette = sidebarPaletteGroup.fragment(
  both({
    sidebar: BG,
    sidebarForeground: INK_2,
    sidebarBorder: LINE,
    sidebarAccent: HOVER,
    sidebarAccentForeground: INK,
  }),
);

/** Inter for text, JetBrains Mono for ids, shas and hosts; smoothed light-on-dark. */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "Inter, system-ui, sans-serif",
    fontMono:
      "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSmoothing: "antialiased",
  }),
);

/** The prototype's 13px UI with 22px page titles. */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBody: "0.8125rem",
    lineHeightBody: "1.15rem",
    fontSizeControl: "0.8125rem",
    lineHeightControl: "1.15rem",
    fontSizeLabel: "0.75rem",
    lineHeightLabel: "1.0625rem",
    fontSizeCaption: "0.75rem",
    lineHeightCaption: "1.0625rem",
    fontSizeTitle: "1.375rem",
    lineHeightTitle: "1.75rem",
  }),
);

const shape = shapeGroup.fragment(both({ radius: "0.625rem" }));

/** A hairline inset highlight over a soft drop, so panels lift off the ground. */
const HAIRLINE = "inset 0 1px 0 oklch(1 0 0 / 0.04)";
const shadow = shadowGroup.fragment(
  both({
    "shadow-sm": `${HAIRLINE}, 0 1px 2px oklch(0 0 0 / 0.4)`,
    shadow: `${HAIRLINE}, 0 1px 3px oklch(0 0 0 / 0.45)`,
    "shadow-md": `${HAIRLINE}, 0 4px 14px -4px oklch(0 0 0 / 0.55)`,
    "shadow-lg": `${HAIRLINE}, 0 10px 30px -8px oklch(0 0 0 / 0.6)`,
  }),
);

/** An indigo-led ramp, from the accent down to a deep violet. */
const chart = chartGroup.fragment(
  both({
    "chart-1": ACCENT,
    "chart-2": "#8f84ff",
    "chart-3": "#4f46d8",
    "chart-4": "#b4adff",
    "chart-5": "#3730a3",
  }),
);

/**
 * The Deploy app's own theme (dark only): the redesign prototype's graphite
 * ground with an indigo accent, Inter and JetBrains Mono. Selected for the app
 * in `config/ui/theme-engine/@app/deploy/theme.jsonc`. A group it does not
 * mention paints that group's schema defaults.
 */
export const deployGraphiteTheme = defineTheme({
  id: "deploy-graphite",
  label: "Deploy Graphite",
  fragments: [
    colorPalette,
    sidebarPalette,
    fontFamily,
    typeScale,
    shape,
    shadow,
    chart,
  ],
});
