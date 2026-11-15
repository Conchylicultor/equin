/**
 * The colours an app's tile can wear — one closed set, shared by every surface
 * that draws an app (the launchers, the desktop, the website's gallery and
 * homepage, the server's icon PNGs), so an app is the same colour everywhere.
 *
 * Each is a bright base in OKLCH (lightness, chroma, hue): the website's
 * vivid launch palette, its hue circle filled in so every app can have a
 * colour of its own. How intense a tile wears it is the theme's
 * (`--app-tile-intensity`, a share of the chroma — {@link APP_TILE_INTENSITIES}):
 * calm on equin's launchers, vivid on the website. A tile paints a gradient from the base darkened by
 * {@link TILE_DEEP_DROP} into the base (`appTileStops`). The same in light and
 * dark mode: a tile is its own fill under a white glyph.
 *
 * Listed in hue order; `slate` is the one neutral (Settings).
 */
export const APP_TILE_COLORS = {
  rose: { l: 0.72, c: 0.18, h: 8 },
  red: { l: 0.66, c: 0.2, h: 26 },
  orange: { l: 0.76, c: 0.17, h: 44 },
  amber: { l: 0.82, c: 0.15, h: 66 },
  gold: { l: 0.76, c: 0.14, h: 84 },
  yellow: { l: 0.88, c: 0.16, h: 100 },
  lime: { l: 0.84, c: 0.18, h: 122 },
  green: { l: 0.72, c: 0.18, h: 140 },
  emerald: { l: 0.8, c: 0.14, h: 158 },
  mint: { l: 0.86, c: 0.11, h: 172 },
  teal: { l: 0.72, c: 0.11, h: 190 },
  cyan: { l: 0.8, c: 0.12, h: 208 },
  sky: { l: 0.76, c: 0.13, h: 228 },
  blue: { l: 0.64, c: 0.17, h: 248 },
  indigo: { l: 0.66, c: 0.17, h: 268 },
  violet: { l: 0.72, c: 0.17, h: 292 },
  purple: { l: 0.62, c: 0.2, h: 308 },
  fuchsia: { l: 0.72, c: 0.21, h: 326 },
  pink: { l: 0.78, c: 0.17, h: 348 },
  slate: { l: 0.7, c: 0.03, h: 250 },
} as const satisfies Record<string, OklchColor>;

export interface OklchColor {
  /** Lightness, 0–1. */
  l: number;
  /** Chroma. */
  c: number;
  /** Hue, degrees. */
  h: number;
}

export type AppTileColor = keyof typeof APP_TILE_COLORS;

export const APP_TILE_COLOR_NAMES = Object.keys(
  APP_TILE_COLORS,
) as readonly AppTileColor[];

/** How much darker the gradient's deep end is than the base (OKLCH lightness). */
export const TILE_DEEP_DROP = 0.28;

/** The angle the tile's gradient runs at: the deep end top-left, the base bottom-right. */
export const TILE_GRADIENT_ANGLE = 140;

/** The colours an app that declares none is given, by its id. `slate` is never handed out. */
const AUTO_COLORS = APP_TILE_COLOR_NAMES.filter((c) => c !== "slate");

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

/** The colour an app's tile wears: the one it declares, else one picked from its id. */
export function appTileColor(
  declared: AppTileColor | undefined,
  appId: string,
): AppTileColor {
  return declared ?? AUTO_COLORS[hash(appId) % AUTO_COLORS.length]!;
}

/**
 * How intense a tile's colour is: a share of its chroma, picked per theme
 * (the `app-tile` token group's `appTileIntensity`). The default is equin's
 * own launchers' — calm; the website turns it up.
 */
export const APP_TILE_INTENSITIES = ["0.55", "0.7", "0.85", "1"] as const;
export type AppTileIntensity = (typeof APP_TILE_INTENSITIES)[number];
export const DEFAULT_APP_TILE_INTENSITY: AppTileIntensity = "0.7";

/**
 * The gradient's two ends, as OKLCH colours: the deep end (top-left) and the
 * base (bottom-right), at `intensity` (a share of the chroma; the default,
 * for a painter with no theme — the icon PNGs).
 */
export function appTileStops(
  color: AppTileColor,
  intensity: number = Number(DEFAULT_APP_TILE_INTENSITY),
): { deep: OklchColor; base: OklchColor } {
  const full = APP_TILE_COLORS[color];
  const base = { ...full, c: full.c * intensity };
  return { deep: { ...base, l: base.l - TILE_DEEP_DROP }, base };
}

/** An OKLCH colour as CSS. */
export function oklchCss({ l, c, h }: OklchColor): string {
  return `oklch(${l.toFixed(3)} ${c} ${h})`;
}
