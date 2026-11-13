import type { AppTilePalette } from "@plugins/apps-core/plugins/app-icon/core";
import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { categoricalGroup } from "@plugins/ui/plugins/tokens/plugins/categorical/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";

/** The prototype's accent (ember): the focused field's ring, the switch on,
 * the send button. */
const ACCENT = "#e8643c";
const ACCENT_RING = "rgb(232 100 60 / 45%)";

/**
 * A macOS menu's palette — the prototype's tray menu (proto-1792791657-kzcrw3)
 * on an opaque panel: the menu material `#f6f6f8`, ink `#1d1d1f`, and every
 * quieter tone the black-at-N% the mock writes, composited over the panel so
 * the palette stays opaque. The same values in both colour modes: the panel is
 * designed light (`menuBarApp` is `colorMode: "light"`), so a dark arm would
 * claim a choice the design does not make.
 */
const PANEL = "#f6f6f8";
const INK = "#1d1d1f";
/** black 6% over the panel: the task field's well, a hovered row. */
const WELL = "#e7e7e9";
/** black 60%: the status line, the footer. */
const MUTED_INK = "#626263";
/** black 42%: the field's placeholder and glyph. */
const FAINT_INK = "#8f8f90";

const colorPalette = colorPaletteGroup.fragment(
  both({
    background: PANEL,
    foreground: INK,
    card: PANEL,
    cardForeground: INK,
    popover: PANEL,
    popoverForeground: INK,
    primary: ACCENT,
    primaryForeground: "#ffffff",
    muted: WELL,
    mutedForeground: MUTED_INK,
    faintForeground: FAINT_INK,
    accent: WELL,
    accentForeground: INK,
    popoverHover: WELL,
    destructive: "#ff3b30",
    success: "#34c759",
    border: "oklch(0 0 0 / 10%)",
    input: "oklch(0 0 0 / 10%)",
    ring: ACCENT_RING,
    switchTrack: "#cacacb",
    switchKnob: "#ffffff",
    switchKnobOn: "#ffffff",
  }),
);

/** The system font, as a native menu draws (SF on macOS). */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans:
      "-apple-system, BlinkMacSystemFont, 'Inter Variable', Ubuntu, system-ui, sans-serif",
  }),
);

/**
 * A menu's type: 13px rows and title, an 11.5px status line and footer, and
 * the app names at 10.5px — the caption's compact rung (`2xs`), which the
 * grid's names step down to.
 */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBody: "13px",
    lineHeightBody: "18px",
    fontSizeLabel: "13px",
    lineHeightLabel: "17.5px",
    fontSizeCaption: "11.5px",
    lineHeightCaption: "15.5px",
    "font-size-2xs": "10.5px",
    "line-height-2xs": "14px",
  }),
);

/**
 * A menu's tighter rhythm: the ramp steps 2 / 4 / 6 / 8 / 10 / 12 / 16px, rows
 * padded 6 × 10px, a 7px status dot, an 8px chrome rail.
 */
const density = densityGroup.fragment(
  both({
    "space-2xs": "2px",
    "space-xs": "4px",
    "space-sm": "6px",
    "space-md": "8px",
    "space-lg": "10px",
    "space-xl": "12px",
    "space-2xl": "16px",
    padRowX: "10px",
    padRowY: "6px",
    statusDotMd: "7px",
    // The rail a band follows when no region opened one: the rules between
    // the panel's sections, 8px in from its padding.
    chromePadX: "8px",
    // The smallest controls: the icon's round + (18px, a 14px glyph) at xs,
    // the task field's send button (22px, 15px) at sm.
    controlHeightXs: "18px",
    controlIconXs: "14px",
    controlHeightSm: "22px",
    controlIconSm: "15px",
  }),
);

/** 8px corners: the field, a hovered row, a grid cell. */
const shape = shapeGroup.fragment(
  both({ radius: "8px", radiusPanelRow: "7px" }),
);

/**
 * The menu material: the panel's fill is the prototype's `rgba(246,246,248,.86)`
 * — the panel colour at 86% — so that where the helper's window is a transparent
 * vibrancy (macOS, `useWindowMaterial`) the blurred desktop shows through. The
 * blur itself is the window's, so there is no backdrop filter. Anywhere else
 * the page sits on the same opaque colour and the fill reads as the panel.
 */
const material = materialGroup.fragment(
  both({
    popoverFill: "color-mix(in oklab, var(--popover) 86%, transparent)",
    popoverBackdrop: "none",
  }),
);

/**
 * The panel's app tiles: the prototype's vivid tiles (each the midpoint of
 * the mock's 135° gradient — the tile presentation lights it from above), one
 * per avatar colour slot, where the rest of equin paints the quieter ocean
 * band (`APP_TILE_PALETTE`). Handed to the tiles by `AppTilePaletteProvider`
 * at the panel's root, and the theme's categorical slots, so anything else
 * categorical in the panel reads the same hues.
 */
export const MENU_TILE_PALETTE: AppTilePalette = {
  /** sky — Mail, Browser */
  "categorical-1": "#3489f0",
  /** emerald — Places */
  "categorical-2": "#2bb873",
  /** amber — Prototypes */
  "categorical-3": "#e7bb2f",
  /** rose — Chord, Deploy */
  "categorical-4": "#eb4d82",
  /** violet — Sonata */
  "categorical-5": "#8f5ef0",
  /** indigo — Files, Desktop */
  "categorical-6": "#628beb",
  /** teal — Studio */
  "categorical-7": "#20b198",
  /** pink — Tap Tap Party */
  "categorical-8": "#f065bb",
  /** orange — Agent Manager (the ember accent), Events */
  "categorical-9": "#f07b36",
  /** slate — Settings, Pages, Debug */
  "categorical-10": "#6e737b",
};

const categorical = categoricalGroup.fragment(both(MENU_TILE_PALETTE));

/**
 * The menu-bar panel's own theme: a native menu's look (the prototype's tray
 * menu). Selected for the menu-bar app in
 * `config/ui/theme-engine/@app/menu-bar/theme.jsonc`; always light
 * (`menuBarApp.colorMode`).
 */
export const menuBarTheme = defineTheme({
  id: "menu-bar",
  label: "Menu bar",
  fragments: [
    colorPalette,
    fontFamily,
    typeScale,
    density,
    shape,
    material,
    categorical,
  ],
});
