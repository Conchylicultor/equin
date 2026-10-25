import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";

// The mockup's palette (proto-1792901196-2xyrv7), per mode: `CHROME` is the
// recessed tab strip and the resting address pill, `SURFACE` the toolbar, the
// active tab and the page, `RAISED` popovers and the start page's search, and
// the accent its azure.
const ACCENT = "#3b82f6";
const LIGHT = {
  CHROME: "#eceef2",
  SURFACE: "#ffffff",
  RAISED: "#ffffff",
  INK: "#1b1d22",
  INK_2: "#6b7180",
  INK_3: "#9aa0ad",
  LINE: "#dfe2e8",
  // The mockup's hover wash (6 % ink) flattened over the surface.
  HOVER: "#f1f1f2",
};
const DARK = {
  CHROME: "#16181d",
  SURFACE: "#202329",
  RAISED: "#272a31",
  INK: "#e8eaef",
  INK_2: "#9ba1ae",
  INK_3: "#6b717d",
  LINE: "#2e323a",
  HOVER: "#2d3036",
};

function palette(p: typeof LIGHT) {
  return {
    background: p.SURFACE,
    foreground: p.INK,
    card: p.RAISED,
    cardForeground: p.INK,
    popover: p.RAISED,
    popoverForeground: p.INK,
    primary: ACCENT,
    primaryForeground: "#ffffff",
    primaryText: ACCENT,
    secondary: p.RAISED,
    secondaryForeground: p.INK,
    muted: p.CHROME,
    mutedForeground: p.INK_2,
    faintForeground: p.INK_3,
    accent: p.HOVER,
    accentForeground: p.INK,
    border: p.LINE,
    input: p.LINE,
    ring: ACCENT,
    switchTrack: p.LINE,
  };
}

const colorPalette = colorPaletteGroup.fragment({
  light: palette(LIGHT),
  dark: palette(DARK),
});

/** The tab strip is the frame's recessed colour (`--sidebar`, the chrome role). */
const sidebarPalette = sidebarPaletteGroup.fragment({
  light: { sidebar: LIGHT.CHROME, sidebarForeground: LIGHT.INK_2 },
  dark: { sidebar: DARK.CHROME, sidebarForeground: DARK.INK_2 },
});

/** The platform's own UI font, as the mockup draws it, smoothed. */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSmoothing: "antialiased",
  }),
);

/**
 * The mockup's 13px UI: body, tab titles and controls at 13px regular, labels
 * and captions at 12px, the start page's search at 15px and its greeting at
 * 30px semibold.
 */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBody: "0.8125rem",
    lineHeightBody: "1.125rem",
    fontSizeControl: "0.8125rem",
    lineHeightControl: "1.125rem",
    fontWeightControl: "400",
    fontSizeLabel: "0.75rem",
    lineHeightLabel: "1.0625rem",
    fontSizeCaption: "0.75rem",
    lineHeightCaption: "1.0625rem",
    fontSizeTitle: "1.875rem",
    lineHeightTitle: "2.625rem",
    fontSizeSubheading: "0.9375rem",
    lineHeightSubheading: "1.375rem",
  }),
);

/**
 * The mockup's control geometry: 30px icon buttons in the toolbar and the tab
 * strip (`sm`), 26px inside the address pill (`xs`); a 46px toolbar (6px around
 * the 34px pill) and a 32px bookmarks bar.
 */
const density = densityGroup.fragment(
  both({
    controlHeightXs: "1.625rem",
    controlHeightSm: "1.875rem",
    controlIconXs: "0.9375rem",
    controlIconSm: "1rem",
    chromeBarH: "2.875rem",
    chromePaneH: "2rem",
    chromePadX: "0.5rem",
  }),
);

/** 8px control corners, 10px panels. */
const shape = shapeGroup.fragment(
  both({
    radius: "0.625rem",
    radiusControlSm: "0.5rem",
    radiusControlXs: "0.5rem",
    radiusPopover: "0.75rem",
  }),
);

/** The mockup's line icons are Lucide's. */
const icons = iconsGroup.fragment(both({ iconFamily: "lucide" }));

/**
 * The Browser app's own theme: the mockup's palette in both modes, its system
 * font and 13px type, Lucide icons and its control geometry. Selected for the
 * app in `config/ui/theme-engine/@app/browser/theme.jsonc`. A group it does not
 * mention paints that group's schema defaults.
 */
export const browserTheme = defineTheme({
  id: "browser",
  label: "Browser",
  fragments: [
    colorPalette,
    sidebarPalette,
    fontFamily,
    typeScale,
    density,
    shape,
    icons,
  ],
});
