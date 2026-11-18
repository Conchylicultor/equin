import { LOGO } from "@plugins/ui/plugins/logo/core";
import type { GlyphBody } from "./shelf";
import { FONT, INKS, esc, type Theme } from "./style";

/** Where a pill's glyph comes from: the Material Symbols set, or the brand (Simple Icons) set. */
export type PillGlyph = { set: "symbol" | "brand"; name: string };

/**
 * One of the README's link pills, under the banner. `primary` is the one
 * call to action the reader should take first (the brand gradient); the rest
 * are outlined on the page. A pill without a `label` is a round icon button.
 */
export interface Pill {
  /** The file's base name in docs/readme/ (`pill-<id>.svg`, `pill-<id>-light.svg`). */
  id: string;
  label?: string;
  glyph: PillGlyph;
  /** The glyph's colour on an outlined pill; a primary pill's glyph is white. */
  tint: (theme: Theme) => string;
  primary?: boolean;
}

export const PILLS: readonly Pill[] = [
  {
    id: "film",
    label: "Watch the film",
    glyph: { set: "symbol", name: "play-arrow-rounded" },
    tint: () => "#ffffff",
    primary: true,
  },
  {
    id: "demo",
    label: "Try the demo",
    glyph: { set: "symbol", name: "web-asset" },
    tint: () => LOGO.gradient.from,
  },
  {
    id: "install",
    label: "Install",
    glyph: { set: "symbol", name: "terminal" },
    tint: (theme) => INKS[theme].green,
  },
  {
    id: "discord",
    glyph: { set: "brand", name: "discord" },
    tint: () => "#5865F2",
  },
];

/** Drawn at twice the size README.md shows it (height 36), so it stays sharp on a dense screen. */
const H = 80;
const FONT_PX = 30;
const PAD = 32;
const GLYPH_PX = 30;
const GAP = 14;

/**
 * The label's width at FONT_PX, estimated per character class for the
 * system UI font at weight 600. An `<img>`-shown SVG cannot measure its own
 * text and the reader's font is not known here, so the pill is sized from an
 * estimate; a label can sit a few pixels off-centre in another font.
 */
function labelWidth(label: string): number {
  let em = 0;
  for (const ch of label) {
    if ("il.,'|".includes(ch)) em += 0.27;
    else if ("fjtr ".includes(ch)) em += 0.34;
    else if ("mwMW".includes(ch)) em += 0.86;
    else if (ch !== ch.toLowerCase()) em += 0.66;
    else em += 0.57;
  }
  return em * FONT_PX;
}

export function pillSvg(
  pill: Pill,
  theme: Theme,
  glyphs: { symbol: GlyphBody; brand: GlyphBody },
): string {
  const ink = INKS[theme];
  const body = glyphs[pill.glyph.set](pill.glyph.name).replace(
    /fill="currentColor"/g,
    "",
  );
  const W = pill.label
    ? Math.round(PAD + GLYPH_PX + GAP + labelWidth(pill.label) + PAD)
    : H;
  const glyphX = pill.label ? PAD : (H - GLYPH_PX) / 2;
  const fill = pill.primary ? "url(#pill-g)" : ink.card;
  const stroke = pill.primary ? "none" : ink.border;
  const fg = pill.primary ? "#ffffff" : ink.fg;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="pill-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${LOGO.gradient.from}"/><stop offset="1" stop-color="${LOGO.gradient.to}"/></linearGradient></defs>
<style>text { ${FONT} font-size: ${FONT_PX}px; font-weight: 600; }</style>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${H / 2 - 1}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
<g transform="translate(${glyphX} ${(H - GLYPH_PX) / 2}) scale(${(GLYPH_PX / 24).toFixed(4)})" fill="${pill.tint(theme)}">${body}</g>${
    pill.label
      ? `\n<text x="${PAD + GLYPH_PX + GAP}" y="${(H / 2 + FONT_PX * 0.35).toFixed(1)}" fill="${fg}">${esc(pill.label)}</text>`
      : ""
  }
</svg>
`;
}
