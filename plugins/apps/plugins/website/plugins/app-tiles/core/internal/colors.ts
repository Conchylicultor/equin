/**
 * The colours an app's tile wears on the website (the gallery's cards, the
 * homepage's shelf): a vivid palette, its hue circle filled in so every app the
 * site lists can have one of its own. The site's look only — equin's own
 * launchers paint apps in `apps-core/app-icon`'s calmer palette.
 *
 * Each is a bright base in OKLCH (lightness, chroma, hue); a tile paints a
 * gradient from the base darkened by {@link TILE_DEEP_DROP} into the base
 * (`websiteTileStops`). The same in light and dark mode: a tile is its own
 * fill under a white glyph.
 *
 * Listed in hue order; `slate` is the one neutral.
 */
export const WEBSITE_TILE_COLORS = {
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

export type WebsiteTileColor = keyof typeof WEBSITE_TILE_COLORS;

/** How much darker the gradient's deep end is than the base (OKLCH lightness). */
export const TILE_DEEP_DROP = 0.28;

/** The angle the tile's gradient runs at: the deep end top-left, the base bottom-right. */
export const TILE_GRADIENT_ANGLE = 140;

/** The gradient's two ends: the deep end (top-left) and the base (bottom-right). */
export function websiteTileStops(color: WebsiteTileColor): {
  deep: OklchColor;
  base: OklchColor;
} {
  const base = WEBSITE_TILE_COLORS[color];
  return { deep: { ...base, l: base.l - TILE_DEEP_DROP }, base };
}

/** An OKLCH colour as CSS. */
export function oklchCss({ l, c, h }: OklchColor): string {
  return `oklch(${l.toFixed(3)} ${c} ${h})`;
}
