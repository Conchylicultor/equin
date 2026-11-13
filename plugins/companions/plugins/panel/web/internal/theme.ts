import { APP_TILE_PALETTE } from "@plugins/apps-core/plugins/app-icon/core";
import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { categoricalGroup } from "@plugins/ui/plugins/tokens/plugins/categorical/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";

/** The prototype's accent (ember): the focused field's ring, the switch on,
 * the send button — the same in both schemes. */
const ACCENT = "#e8643c";
const ACCENT_RING = "rgb(232 100 60 / 45%)";

/**
 * Light: a macOS menu's palette — the tray menu prototype
 * (proto-1792791657-kzcrw3): the menu material `#f6f6f8`, ink `#1d1d1f`, and
 * every quieter tone the black-at-N% the mock writes, kept translucent as the
 * mock writes it — so that over the helper's vibrancy material the desktop
 * tints them as it tints the panel (composited over an opaque panel colour
 * they read as flat light greys, brighter than the menu around them).
 */
const LIGHT = {
  panel: "#f6f6f8",
  ink: "#1d1d1f",
  /** black 6%: the Wish field's well, a hovered row. */
  well: "rgb(0 0 0 / 6%)",
  hover: "rgb(0 0 0 / 6%)",
  /** black 60%: the status line, the footer. */
  mutedInk: "rgb(0 0 0 / 60%)",
  /** black 42%: the field's placeholder and glyph. */
  faintInk: "rgb(0 0 0 / 42%)",
  border: "oklch(0 0 0 / 10%)",
  /** black 18%: the switch's track when off. */
  switchTrack: "rgb(0 0 0 / 18%)",
  destructive: "#ff3b30",
  success: "#34c759",
};

/**
 * Light, on a solid surface (the Chrome popup: its own opaque window, nothing
 * behind it to blur): the panel is `#e2e6ea` — the translucent fill as it
 * renders over the wallpaper, which is the colour the popover prototype paints
 * — and every quieter tone is the same black-at-N% composited over it.
 */
const LIGHT_SOLID: typeof LIGHT = {
  ...LIGHT,
  panel: "#e2e6ea",
  /** black 6% over the panel. */
  well: "#d4d8dc",
  hover: "#d4d8dc",
  /** black 60%. */
  mutedInk: "#5a5c5e",
  /** black 42%. */
  faintInk: "#838588",
  switchTrack: "#b9bdc0",
};

/**
 * Dark: the browser-extension popover prototype (proto-1794537939-tuvpg1) in
 * its dark scheme — a `#2b2b2b` panel ringed `#3d3d3d`, ink `#eeeeee`, a
 * hovered row white-8% and the prompt field's well sunk black-18% — each
 * composited over the panel, as the light palette is.
 */
const DARK = {
  panel: "#2b2b2b",
  ink: "#eeeeee",
  /** black 18% over the panel: the sunk prompt-field well. */
  well: "#232323",
  /** white 8% over the panel: a hovered row, a chip. */
  hover: "#3c3c3c",
  /** white 55%: the status line, the footer. */
  mutedInk: "#a0a0a0",
  /** white 45%: the field's placeholder and glyph. */
  faintInk: "#8a8a8a",
  border: "#3d3d3d",
  switchTrack: "#5a5a5a",
  destructive: "#ff453a",
  success: "#30d158",
};

function palette(p: typeof LIGHT) {
  return {
    background: p.panel,
    foreground: p.ink,
    card: p.panel,
    cardForeground: p.ink,
    popover: p.panel,
    popoverForeground: p.ink,
    primary: ACCENT,
    primaryForeground: "#ffffff",
    muted: p.well,
    // The Wish field (the task composer) sits in the well, a shade off the
    // panel, its hairline still showing around it.
    composer: p.well,
    mutedForeground: p.mutedInk,
    faintForeground: p.faintInk,
    accent: p.hover,
    accentForeground: p.ink,
    popoverHover: p.hover,
    destructive: p.destructive,
    success: p.success,
    border: p.border,
    input: p.border,
    ring: ACCENT_RING,
    switchTrack: p.switchTrack,
    switchKnob: "#ffffff",
    switchKnobOn: "#ffffff",
  };
}

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

const categorical = categoricalGroup.fragment(both(APP_TILE_PALETTE));

/**
 * What a companion's window is made of, which decides how its panel paints:
 *
 * - `translucent` — a transparent system material (the menu bar's helper
 *   window, macOS vibrancy): light, the panel draws NO fill of its own. The
 *   prototype's `rgba(246,246,248,.86)` + blur is its CSS stand-in for macOS's
 *   menu material, which the helper's window already IS — painting the 86%
 *   fill on top stacked a second light layer and the panel read near-opaque
 *   white. Anywhere else (a browser tab, an opaque window) the page's own
 *   background is the panel colour, so the clear fill reads as the panel.
 * - `solid` — an opaque window with nothing behind it (the Chrome popup):
 *   light, the panel is that fill as it looks over the wallpaper, opaque
 *   (`LIGHT_SOLID`).
 *
 * Dark is the same for both: the popover prototype's dark panel is opaque
 * (`#2b2b2b`, no blur), so the fill is the panel itself.
 */
export type CompanionMaterial = "translucent" | "solid";

function companionThemeFor(
  material: CompanionMaterial,
  id: string,
  label: string,
) {
  return defineTheme({
    id,
    label,
    fragments: [
      colorPaletteGroup.fragment({
        light: palette(material === "solid" ? LIGHT_SOLID : LIGHT),
        dark: palette(DARK),
      }),
      fontFamily,
      typeScale,
      density,
      shape,
      materialGroup.fragment({
        light: {
          popoverFill: material === "solid" ? "var(--popover)" : "transparent",
          popoverBackdrop: "none",
        },
        dark: { popoverFill: "var(--popover)", popoverBackdrop: "none" },
      }),
      categorical,
    ],
  });
}

/**
 * The companions' themes: a native menu's look (the tray prototype), light
 * and dark, one per window material. A companion app selects the one its
 * window is made of in `config/ui/theme-engine/@app/<app>/theme.jsonc` —
 * `companion` (translucent: the menu bar) or `companion-solid` (the Chrome
 * popup) — and declares `colorMode: "system"`, so the scheme follows the OS.
 */
export const companionTheme = companionThemeFor(
  "translucent",
  "companion",
  "Companion",
);
export const companionSolidTheme = companionThemeFor(
  "solid",
  "companion-solid",
  "Companion (solid)",
);
