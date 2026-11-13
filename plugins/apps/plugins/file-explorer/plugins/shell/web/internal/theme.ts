import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";
import { sidebarMetricsGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-metrics/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { fileTypePaletteGroup } from "@plugins/ui/plugins/tokens/plugins/file-type-palette/core";

/**
 * The Files look (prototype proto-1790864772-0r54): neutral zinc greys, a
 * tonal sidebar one step below the white tree, hairlines in the soft line, and
 * one blue accent — the active place's icon, the storage bar, a selected row's
 * fill and text.
 *
 * Every value is the mockup's `:root` custom property of the same name.
 */
const LIGHT = {
  sidebar: "#f3f3f5",
  surface: "#ffffff",
  line: "#e4e4e7",
  lineSoft: "#efeff1",
  hover: "rgb(0 0 0 / 0.04)",
  fill: "#f3f3f5",
  text: "#18181b",
  muted: "#5f5f68",
  faint: "#9a9aa3",
  accent: "#2563eb",
  accentSoft: "#e6eefd",
  accentText: "#1d4fd0",
  folder: "#3b82f6",
};

const DARK: typeof LIGHT = {
  sidebar: "#111113",
  surface: "#18181b",
  line: "#2a2a2e",
  lineSoft: "#222225",
  hover: "rgb(255 255 255 / 0.05)",
  fill: "#222225",
  text: "#ededef",
  muted: "#a1a1aa",
  faint: "#6b6b73",
  accent: "#3b82f6",
  accentSoft: "#1c2b47",
  accentText: "#93bbfd",
  folder: "#60a5fa",
};

function palette(c: typeof LIGHT, onAccent: string) {
  return {
    background: c.surface,
    foreground: c.text,
    card: c.surface,
    cardForeground: c.text,
    popover: c.surface,
    popoverForeground: c.text,
    primary: c.accent,
    primaryForeground: onAccent,
    secondary: c.fill,
    secondaryForeground: c.text,
    // The quiet grey well: the filter field, the active renderer tab.
    muted: c.fill,
    mutedForeground: c.muted,
    faintForeground: c.faint,
    // Hover: a translucent wash over whatever surface is under it.
    accent: c.hover,
    accentForeground: c.text,
    // A selected row: the accent-soft fill, its name and its date / size in
    // the accent text tier.
    selected: c.accentSoft,
    selectedForeground: c.accentText,
    selectedMetaForeground: c.accentText,
    treeGuide: c.lineSoft,
    groupForeground: c.faint,
    // Every bar's rule (toolbar, column head, status bar, preview header) is
    // the soft line; the outlined button and the field outline the firmer one.
    border: c.lineSoft,
    input: c.line,
    outlineBorder: c.line,
    ring: c.accent,
    toolbarForeground: c.muted,
  };
}

const colorPalette = colorPaletteGroup.fragment({
  light: palette(LIGHT, "#ffffff"),
  dark: palette(DARK, "#ffffff"),
});

/**
 * The sidebar is one tonal step below the tree, with no edge of its own. Its
 * rows are muted text; hover and the active place share the translucent wash
 * with full text, and the active place's icon takes the accent.
 */
function sidebar(c: typeof LIGHT) {
  return {
    sidebar: c.sidebar,
    sidebarForeground: c.muted,
    sidebarPrimary: c.accent,
    sidebarPrimaryForeground: "#ffffff",
    sidebarBorder: "transparent",
    sidebarAccent: c.hover,
    sidebarAccentForeground: c.text,
    sidebarIcon: "currentColor",
    sidebarRing: c.accent,
  };
}

const sidebarPalette = sidebarPaletteGroup.fragment({
  light: sidebar(LIGHT),
  dark: sidebar(DARK),
});

/**
 * A 224px sidebar on a 10px rail of 28px rows, 8px padded, a 10px gap after
 * the 16px icon; headed by the 16px folder mark, centred in the launcher's
 * 32px button, with the name straight after it (8px from the glyph's box).
 */
const sidebarMetrics = sidebarMetricsGroup.fragment(
  both({
    sidebarRail: "0.625rem",
    sidebarBrandMarkSize: "1rem",
    sidebarBrandGap: "0px",
    sidebarBrandNamePadX: "0px",
    sidebarPanelWidth: "14rem",
    sidebarRowHeight: "1.75rem",
    sidebarRowPadX: "0.5rem",
    sidebarIconSize: "1rem",
    sidebarIconGap: "0.625rem",
  }),
);

/**
 * A 48px toolbar and preview header inset 8px; the sidebar's brand header
 * inset 10px (its rail). 30px tree rows, each level 24px in (the mockup's
 * 18px guide box and 6px gap) with its guide 9px into the step; root rows
 * packed with no gap. Section heads sit tight on their rows.
 */
const density = densityGroup.fragment(
  both({
    chromePadX: "0.625rem",
    chromeBarH: "3rem",
    chromePaneH: "3rem",
    treeRowH: "1.875rem",
    treeIndent: "24px",
    treeGuideX: "9px",
    treeRootGap: "0px",
    sectionHeadPadTop: "0px",
    sectionHeadPadBottom: "0px",
    sectionBodyPadTop: "0px",
    // 28px places: an 18px label line padded 5px.
    padRowY: "0.3125rem",
  }),
);

/**
 * The mockup's type, as roles: 13px on a 1.4 line for everything inherited
 * (names, places, the path bar), 12px `caption` (Modified / Size), 11px
 * `2xs` and `group` (column heads, section heads, the status bar, the
 * preview's meta line), 13px medium controls.
 */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBase: "0.8125rem",
    lineHeightBase: "1.4",
    fontSizeBody: "0.8125rem",
    lineHeightBody: "1.125rem",
    fontSizeLabel: "0.8125rem",
    lineHeightLabel: "1.125rem",
    fontSizeCaption: "0.75rem",
    lineHeightCaption: "1rem",
    fontSizeControl: "0.8125rem",
    lineHeightControl: "1.125rem",
    fontWeightControl: "500",
    fontSizeGroup: "0.6875rem",
    lineHeightGroup: "0.9375rem",
    fontWeightGroup: "600",
  }),
);

/**
 * The mockup's glyph rendering: antialiased, so light-on-dark text keeps the
 * font's own weight instead of macOS's thickened stems. The faces stay the
 * bundled defaults (Inter, Cascadia), so Files reads the same on every system.
 */
const fontFamily = fontFamilyGroup.fragment(
  both({ fontSmoothing: "antialiased" }),
);

/** 6px corners on rows, controls and the filter field. */
const shape = shapeGroup.fragment(
  both({
    radius: "0.46875rem",
    radiusControl: "0.375rem",
    radiusPanelRow: "0.375rem",
  }),
);

/** Lucide, tuned light (7/8 of the box, ~1.2px stroke). */
const icons = iconsGroup.fragment(both({ iconFamily: "lucide" }));

/**
 * Seti's own tints in both modes, as the mockup draws them (the default light
 * values are darkened for contrast), and the folder in the mockup's blue.
 */
const SETI = {
  fileBlue: "#519aba",
  fileYellow: "#cbcb41",
  fileGreen: "#8dc149",
  fileRed: "#cc3e44",
  filePurple: "#a074c4",
  filePink: "#f55385",
  fileOrange: "#e37933",
  fileGrey: "#6d8086",
};
const fileTypePalette = fileTypePaletteGroup.fragment({
  light: { ...SETI, folder: LIGHT.folder },
  dark: { ...SETI, folder: DARK.folder },
});

/**
 * The Files app's own theme. Selected for the app in
 * `config/ui/theme-engine/@app/file-explorer/theme.jsonc`; a group it does not
 * mention paints that group's schema defaults, never the desktop's choice.
 */
export const filesTheme = defineTheme({
  id: "files",
  label: "Files",
  fragments: [
    colorPalette,
    sidebarPalette,
    sidebarMetrics,
    density,
    typeScale,
    fontFamily,
    shape,
    icons,
    fileTypePalette,
  ],
});
