import { defineTheme, both } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";

/** The desktop's accent — the mockup's indigo. Pips, the selection tint, the
 * launcher's highlight and every app tile's gradient read it (`--primary`). */
const INDIGO = "#4f6bff";
const INK = "#16181d";

/**
 * The desktop chrome's palette: the mockup's light frosted chrome
 * (`data-chrome="light"`), worn by the shelf, its popovers, the menus, the
 * launcher and the switcher over whatever the windows' apps wear.
 *
 * The same values in both colour modes: the chrome is designed light — a
 * frosted panel the wallpaper shows through — over light AND dark apps alike,
 * and the colour mode is one global setting, so a dark arm would claim a choice
 * the desktop's design does not make. The palette stays opaque, as every
 * group expects: the overlays' translucency is the {@link material} below, and
 * the dock applies its own alpha (`bg-background/55`).
 */
const colorPalette = colorPaletteGroup.fragment(
  both({
    background: "#fafafc",
    foreground: "#1b1d22",
    card: "#ffffff",
    cardForeground: INK,
    popover: "#fcfcfd",
    popoverForeground: INK,
    primary: INDIGO,
    primaryForeground: "#ffffff",
    secondary: "#f3f4f6",
    secondaryForeground: INK,
    muted: "#eef0f3",
    mutedForeground: "#4a505c",
    faintForeground: "#8a909c",
    accent: "oklch(0.2 0.02 265 / 6%)",
    accentForeground: INK,
    destructive: "#d64545",
    destructiveForeground: "#ffffff",
    success: "#1f9d5c",
    successForeground: "#ffffff",
    warning: "#c9821b",
    warningForeground: "#ffffff",
    info: INDIGO,
    infoForeground: "#ffffff",
    border: "oklch(0.2 0.02 265 / 9%)",
    input: "oklch(0.2 0.02 265 / 14%)",
    ring: INDIGO,
  }),
);

/** Inter, the bundled variable face — the mockup's typeface. */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Inter Variable', sans-serif",
    fontSerif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    fontMono: "'Cascadia Code Variable', monospace",
    letterSpacing: "0em",
  }),
);

/** 8px controls (`rounded-lg`); a menu's 12px corner is `rounded-xl`. */
const shape = shapeGroup.fragment(
  both({ radius: "0.5rem", spacing: "0.25rem", pillPadExtra: "0.375rem" }),
);

/** The mockup's lifted-panel shadow (dock, popovers, launcher). */
const shadow = shadowGroup.fragment(
  both({
    "shadow-popover":
      "0 0 0 0.5px rgba(0,0,0,0.12), 0 12px 32px -8px rgba(10,15,30,0.32)",
    "shadow-xl":
      "0 0 0 0.5px rgba(0,0,0,0.12), 0 24px 64px -16px rgba(10,15,30,0.45)",
  }),
);

/**
 * The mockup's frosted menu glass (`--menu-bg`: the popover at 90%, blur 30
 * saturate 1.8): every overlay opened in the desktop's scope — the window
 * system menu, the shelf and launcher app menus, the desktop's context menu,
 * the shelf peek, the launcher, the switcher — wears it.
 */
const material = materialGroup.fragment(
  both({
    popoverFill: "color-mix(in oklab, var(--popover) 90%, transparent)",
    popoverBackdrop: "blur(30px) saturate(1.8)",
  }),
);

/**
 * The Desktop's own theme — the look of everything the desktop draws around
 * its windows. Selected for the desktop app in
 * `config/ui/theme-engine/@app/desktop/theme.jsonc`, and switchable like any
 * app's ("Customize for Desktop"). Windows keep their own app's theme; the
 * global action bar keeps the fixed graphite chrome theme.
 */
export const desktopTheme = defineTheme({
  id: "desktop",
  label: "Desktop",
  fragments: [colorPalette, fontFamily, shape, shadow, material],
});
