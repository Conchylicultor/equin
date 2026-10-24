export interface AppIconSvgOptions {
  /** Canvas size in px (square). Default 512. */
  size?: number;
  /** CSS color for the rounded-rect background, or null for transparent. Default "#18181b". */
  background?: string | null;
  /** Rounded-rect corner radius in px. Default Math.round(size * 0.22). */
  cornerRadius?: number;
  /** Glyph fill color (resvg has no currentColor). Default "#ffffff". */
  foreground?: string;
  /** Glyph margin as a fraction of size. Default 0.18. */
  padding?: number;
}

/** One glyph's drawable markup and box — what `symbolBody` (icons server) reads for an app icon's symbol. */
export interface AppIconGlyph {
  body: string;
  width: number;
  height: number;
}

/**
 * Rasterizable SVG markup for an app icon's glyph. Runtime-agnostic, pure, and
 * synchronous — the release CLI resolves the app's symbol to its glyph and feeds
 * this to resvg to mint favicon / Tauri window icons without a browser. The
 * `<g fill color>` replaces the web's `currentColor` inheritance, since the
 * rasterizer has no ambient color: `fill` for a glyph that inherits it, `color`
 * for one whose paths say `fill="currentColor"` (Material Symbols do).
 */
export function appIconToSvg(
  glyph: AppIconGlyph,
  opts: AppIconSvgOptions = {},
): string {
  const size = opts.size ?? 512;
  const background =
    opts.background === undefined ? "#18181b" : opts.background;
  const cornerRadius = opts.cornerRadius ?? Math.round(size * 0.22);
  const foreground = opts.foreground ?? "#ffffff";
  const padding = opts.padding ?? 0.18;

  const inner = size * (1 - 2 * padding);
  const scale = inner / Math.max(glyph.width, glyph.height);
  const translate = size * padding;
  const bg =
    background != null
      ? `<rect width="${size}" height="${size}" rx="${cornerRadius}" fill="${background}"/>`
      : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    bg +
    `<g transform="translate(${translate},${translate}) scale(${scale})" fill="${foreground}" color="${foreground}">` +
    glyph.body +
    `</g>` +
    `</svg>`
  );
}
