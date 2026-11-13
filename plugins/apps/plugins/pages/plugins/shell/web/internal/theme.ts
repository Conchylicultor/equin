import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";
import { sidebarMetricsGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-metrics/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";

/**
 * Ink, the Pages look (prototype proto-1790691924-p8nh): dark graphite
 * surfaces, the sidebar a step darker than the page, and text in four tiers.
 *
 * The surface ramp, darkest first: the sidebar (`bg-0`), the page (`bg-1`),
 * the hover / popover fill (`bg-2`), then the selected fill (`bg-3`) — a
 * selected row and a hovered popover row sit one step above a hovered row.
 *
 * Colours are dark-only (`light: {}`): light mode keeps the schema defaults.
 * Metrics apply in both modes (user, 2026-10-02).
 */
const INK = {
  bg0: "#0c0c0e",
  bg1: "#141416",
  bg2: "#1b1b1e",
  bg3: "#242428",
  line: "rgba(255, 255, 255, 0.06)",
  lineStrong: "rgba(255, 255, 255, 0.1)",
  // Title and active text.
  fg1: "#f0f0f2",
  // Body text.
  fg2: "#c8c8cf",
  // Secondary text and icons.
  fg3: "#8a8a93",
  // Faint text: hints, group heads.
  fg4: "#5a5a63",
};

const colorPalette = colorPaletteGroup.fragment({
  light: {},
  dark: {
    background: INK.bg1,
    foreground: INK.fg2,
    popover: INK.bg2,
    popoverForeground: INK.fg2,
    muted: INK.bg2,
    mutedForeground: INK.fg3,
    faintForeground: INK.fg4,
    // Hover. A selected row is its own, brighter tier (`selected`).
    accent: INK.bg2,
    // A selected row's label (and a highlighted menu row's) is the title tier.
    accentForeground: INK.fg1,
    selected: INK.bg3,
    strongForeground: INK.fg1,
    groupForeground: INK.fg4,
    // The pane header's icon actions (sidebar toggle, copy id, star, …).
    toolbarForeground: INK.fg3,
    border: INK.line,
    popoverBorder: INK.lineStrong,
  },
});

/** The sidebar is the darkest surface, edged by the one hairline. */
const sidebarPalette = sidebarPaletteGroup.fragment({
  light: {},
  dark: {
    sidebar: INK.bg0,
    sidebarForeground: INK.fg2,
    sidebarBorder: INK.line,
    sidebarAccent: INK.bg2,
    sidebarAccentForeground: INK.fg1,
    sidebarIcon: INK.fg3,
  },
});

/**
 * A 260px sidebar of 30px rows, ending 8px above its bottom edge, headed by
 * the workspace row: a 34px row hung 10px below the sidebar's top edge, its
 * 22px tile 16px in (the launcher's 32px button 11px in) and the name 10px
 * after the tile (the button's 5px edge + the name's own 5px pad).
 */
const sidebarMetrics = sidebarMetricsGroup.fragment(
  both({
    // 261px: the mockup's 260px sidebar plus the 1px rule it draws on the
    // page's side, which here sits inside the sidebar's own box.
    sidebarPanelWidth: "16.3125rem",
    sidebarRowHeight: "1.875rem",
    sidebarEndPad: "0.5rem",
    sidebarBrandHeight: "2.75rem",
    sidebarBrandPad: "0.625rem 0.6875rem 0",
    sidebarBrandMarkSize: "1.375rem",
    sidebarBrandGap: "0px",
    sidebarBrandNamePadX: "0.3125rem",
  }),
);

/**
 * A 46px pane header with no bottom rule, 30px tree rows indented 14px per
 * level — the row's pill with them — (root rows packed with no gap), and the
 * mockup's popovers: a 248px menu (the section ⋯ panel), a
 * 300px described menu (the page-kind menu), a 328px picker (icon and cover),
 * each a 6px-inset panel of 30px rows. A sidebar section head opens with
 * 14px above its label row and 2px below, so the 16px gap between sections
 * sits above each head and its rows hang right under it.
 */
const density = densityGroup.fragment(
  both({
    chromePaneH: "2.875rem",
    chromePaneRule: "0",
    treeRowH: "1.875rem",
    treeIndent: "14px",
    // The mockup's 8px row inset, 18px icon box and 8px gap, on the tree's
    // 20px disclosure box: the icon centred 17px into the row, the label 34px.
    treeRowPadStart: "7px",
    treeRowGap: "7px",
    // A nested row's fill starts under its parent's icon, not at the edge.
    treePillIndent: "14px",
    treeRootGap: "0px",
    popoverWidthMenuMax: "15.5rem",
    popoverWidthDescribed: "18.75rem",
    popoverWidthPicker: "20.5rem",
    panelPad: "0.375rem",
    panelRowH: "1.875rem",
    sectionHeadPadTop: "0.875rem",
    sectionHeadPadBottom: "0.125rem",
  }),
);

/**
 * The mockup's chrome type, set as roles only:
 *
 * - 13.5px `body` (sidebar rows, the breadcrumb) on a 22px line, so a 30px
 *   tree row (`treeRowH` plus its 4px block padding) is not pushed taller.
 *   The page's own prose is the editor's separate `doc-text-*` scale and is
 *   untouched;
 * - 13px `label` (the schema default: the sidebar's search field) and 12.5px
 *   `caption`;
 * - 11.5px `group` (section heads) at weight 550;
 * - 38px `display` (the page title) on a 1.15 line at weight 650.
 *
 * The reading measure is the page header's column: a 648px content box plus
 * the editor's rail and inset on each side (`BLOCK_GUTTER` 64px +
 * `BLOCK_INSET` = the `md` step, in `page/editor`'s `page-column.ts`) — 800px
 * at the default density.
 */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBody: "0.84375rem",
    lineHeightBody: "1.375rem",
    fontSizeCaption: "0.78125rem",
    fontSizeGroup: "0.71875rem",
    fontWeightGroup: "550",
    fontSizeDisplay: "2.375rem",
    lineHeightDisplay: "2.73125rem",
    fontWeightDisplay: "650",
    measureReading: "calc(648px + 2 * (64px + var(--space-md)))",
  }),
);

/** 8px corners, 6px controls, 10px cards and popovers, 7px popover rows. */
const shape = shapeGroup.fragment(
  both({
    radius: "0.5rem",
    radiusControl: "0.375rem",
    radiusCard: "0.625rem",
    radiusPopover: "0.625rem",
    radiusPanelRow: "0.4375rem",
  }),
);

/**
 * A popover floats on one deep, soft shadow; every other tier is the default.
 * Dark only, like the colours: at 70% black it is a dark-surface shadow.
 */
const shadow = shadowGroup.fragment({
  light: {},
  dark: {
    "shadow-popover": "0 18px 48px -12px rgba(0, 0, 0, 0.7)",
  },
});

/** Inter, drawn `antialiased` as the mockup is. */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Inter Variable', sans-serif",
    fontSmoothing: "antialiased",
  }),
);

/** Material Symbols Rounded, outline, regular weight. */
const icons = iconsGroup.fragment(
  both({
    iconShape: "rounded",
    iconFill: "outline",
    iconStroke: "regular",
  }),
);

/**
 * The Pages app's own theme. Selected for the app in
 * `config/ui/theme-engine/@app/pages/theme.jsonc`; a group it does not mention
 * paints that group's schema defaults, never the desktop's choice.
 */
export const pagesInkTheme = defineTheme({
  id: "pages-ink",
  label: "Ink",
  fragments: [
    colorPalette,
    sidebarPalette,
    sidebarMetrics,
    density,
    typeScale,
    shape,
    shadow,
    fontFamily,
    icons,
  ],
});
