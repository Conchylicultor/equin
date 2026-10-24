/** A tweakcn theme's `cssVars`, as tweakcn.com serves them. */
export interface TweakcnCssVars {
  theme: Record<string, string>;
  light: Record<string, string>;
  dark: Record<string, string>;
}

/**
 * One token group's values from a tweakcn theme — every token value defined,
 * which is the shape a saved theme stores (and a `TokenGroupFragment`).
 */
export interface TweakcnFragment {
  groupId: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Pick keys from source, renaming via keyMap (tweakcn key → equin key). */
function pick(
  source: Record<string, string>,
  keyMap: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tweakcnKey, singularityKey] of Object.entries(keyMap)) {
    if (tweakcnKey in source) {
      out[singularityKey] = source[tweakcnKey]!;
    }
  }
  return out;
}

const COLOR_PALETTE_MAP: Record<string, string> = {
  background: "background",
  foreground: "foreground",
  card: "card",
  "card-foreground": "cardForeground",
  popover: "popover",
  "popover-foreground": "popoverForeground",
  primary: "primary",
  "primary-foreground": "primaryForeground",
  secondary: "secondary",
  "secondary-foreground": "secondaryForeground",
  muted: "muted",
  "muted-foreground": "mutedForeground",
  accent: "accent",
  "accent-foreground": "accentForeground",
  destructive: "destructive",
  "destructive-foreground": "destructiveForeground",
  success: "success",
  "success-foreground": "successForeground",
  warning: "warning",
  "warning-foreground": "warningForeground",
  info: "info",
  "info-foreground": "infoForeground",
  border: "border",
  input: "input",
  ring: "ring",
};

const SIDEBAR_PALETTE_MAP: Record<string, string> = {
  sidebar: "sidebar",
  "sidebar-foreground": "sidebarForeground",
  "sidebar-primary": "sidebarPrimary",
  "sidebar-primary-foreground": "sidebarPrimaryForeground",
  "sidebar-accent": "sidebarAccent",
  "sidebar-accent-foreground": "sidebarAccentForeground",
  "sidebar-border": "sidebarBorder",
  "sidebar-ring": "sidebarRing",
};

const SHADOW_KEYS = [
  "shadow-2xs",
  "shadow-xs",
  "shadow-sm",
  "shadow",
  "shadow-md",
  "shadow-lg",
  "shadow-xl",
  "shadow-2xl",
];

const CHART_KEYS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

/**
 * A tweakcn theme's color-palette token values (`primary`, `background`, …) per
 * mode — enough to draw a swatch of a catalog theme without saving it.
 */
export function tweakcnPalettePreview(cssVars: TweakcnCssVars): {
  light: Record<string, string>;
  dark: Record<string, string>;
} {
  return {
    light: pick(cssVars.light, COLOR_PALETTE_MAP),
    dark: pick(cssVars.dark, COLOR_PALETTE_MAP),
  };
}

/**
 * Convert a tweakcn theme into the token-group fragments of an equin theme.
 *
 * tweakcn carries colour, sidebar, shape, shadow, chart and font identity — never
 * a type scale, density or categorical palette — so those groups are simply not
 * mentioned, and a theme built from this paints their schema defaults. A group
 * tweakcn gave no values for is left out rather than emitted empty.
 *
 * The fragments are plain literals keyed by group id rather than built through
 * each group's typed `.fragment()`: importing six token-group plugins into
 * tweakcn's core would couple it to all of them, and a key the group does not
 * declare is dropped and reported by the resolver anyway.
 */
export function convertTweakcnTheme(
  cssVars: TweakcnCssVars,
): TweakcnFragment[] {
  const fragments: TweakcnFragment[] = [];
  const add = (
    groupId: string,
    light: Record<string, string>,
    dark: Record<string, string>,
  ) => {
    if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
      return;
    }
    fragments.push({ groupId, light, dark });
  };

  // color-palette: 25 tokens from light/dark
  add(
    "color-palette",
    pick(cssVars.light, COLOR_PALETTE_MAP),
    pick(cssVars.dark, COLOR_PALETTE_MAP),
  );

  // sidebar-palette: 8 tokens from light/dark
  add(
    "sidebar-palette",
    pick(cssVars.light, SIDEBAR_PALETTE_MAP),
    pick(cssVars.dark, SIDEBAR_PALETTE_MAP),
  );

  // shape: radius from theme (mode-independent), spacing from light only
  const shape: Record<string, string> = {};
  if ("radius" in cssVars.theme) shape.radius = cssVars.theme.radius!;
  if ("spacing" in cssVars.light) shape.spacing = cssVars.light.spacing!;
  add("shape", shape, { ...shape });

  // shadow: 8 tokens, verbatim kebab keys from light/dark
  const shadowIdentityMap: Record<string, string> = {};
  for (const k of SHADOW_KEYS) shadowIdentityMap[k] = k;
  add(
    "shadow",
    pick(cssVars.light, shadowIdentityMap),
    pick(cssVars.dark, shadowIdentityMap),
  );

  // chart: 5 tokens, verbatim kebab keys from light/dark
  const chartIdentityMap: Record<string, string> = {};
  for (const k of CHART_KEYS) chartIdentityMap[k] = k;
  add(
    "chart",
    pick(cssVars.light, chartIdentityMap),
    pick(cssVars.dark, chartIdentityMap),
  );

  // font-family: font-* from theme (mode-independent), tracking-normal from
  // light only. tweakcn themes carry font identity but never a type scale, so
  // they target the `font-family` group exclusively.
  const FONT_FAMILY_MAP: Record<string, string> = {
    "font-sans": "fontSans",
    "font-mono": "fontMono",
    "font-serif": "fontSerif",
  };
  const fonts = pick(cssVars.theme, FONT_FAMILY_MAP);
  // tracking-normal → letterSpacing, from light only (used for both modes)
  if ("tracking-normal" in cssVars.light) {
    fonts.letterSpacing = cssVars.light["tracking-normal"]!;
  }
  add("font-family", fonts, { ...fonts });

  return fragments;
}
