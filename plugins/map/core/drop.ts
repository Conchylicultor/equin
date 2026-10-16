/**
 * The teardrop pin head as SVG: a square with three round corners turned −45°
 * so the square corner points down — the tip — or, far out, a disc. The map's
 * place pins (a page's /place blocks, the Places app) all draw this one shape.
 */
import { escapeSvg } from "./mark";

export type DropShape = "drop" | "disc";

/** An icon's standalone SVG content — `IconMarkup`'s ready arm. */
export interface DropIcon {
  viewBox: string;
  body: string;
}

export interface DropHeadInput {
  shape: DropShape;
  /** The square box the head fills, px. */
  sizePx: number;
  /**
   * The fill's colours: one fills it solid, several are equal slices from the
   * visual top, clockwise. Concrete CSS colours (`var()` only for an SVG
   * drawn inline in the DOM).
   */
  fills: readonly string[];
  /** A white veil over the fill at this opacity (a washed, "pale" head). */
  veil?: number;
  /** The outline's colour: 2px, inside the box. */
  ring: string;
  /** The glyph, centred and upright; absent draws the head alone (still loading). */
  icon?: { markup: DropIcon; sizePx: number; ink: string; shadow?: boolean };
  /** Prefix for the ids the SVG defines — unique per look (`markIdPrefix`). */
  id: string;
}

/** The outline's width, inside the box like a border-box border. */
const OUTLINE_PX = 2;

/** How far the tip reaches below the head's top: a radius plus the turned corner's reach (√2·r). */
export function dropTipPx(sizePx: number): number {
  return Math.round(sizePx / 2 + sizePx / Math.SQRT2);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `n` equal slices of a disc centred at `(c, c)` as SVG wedge paths, from the
 * top, clockwise (SVG has no conic gradient). Each reaches `reach` from the
 * centre: enough to cover whatever clips it.
 */
export function sliceWedges(n: number, c: number, reach: number): string[] {
  if (n < 2) throw new Error(`sliceWedges: needs two slices or more, got ${n}`);
  const at = (turn: number) => {
    const a = turn * 2 * Math.PI;
    return `${round(c + reach * Math.sin(a))} ${round(c - reach * Math.cos(a))}`;
  };
  const large = 1 / n > 0.5 ? 1 : 0;
  return Array.from(
    { length: n },
    (_, i) =>
      `M ${c} ${c} L ${at(i / n)} A ${reach} ${reach} 0 ${large} 1 ${at((i + 1) / n)} Z`,
  );
}

/**
 * The head's markup in its `sizePx` square box (the tip and the soft shadow
 * reach past it: draw it with overflow visible, or with room around it).
 */
export function dropHeadSvg({
  shape,
  sizePx: s,
  fills,
  veil,
  ring,
  icon,
  id,
}: DropHeadInput): string {
  if (fills.length === 0) throw new Error("dropHeadSvg: no fill colour");
  const c = s / 2;
  const r = s / 2;
  // The shape before the turn: a circle, or one whose bottom-left corner is
  // square — the turn makes that corner the tip.
  const outline =
    shape === "disc"
      ? `M ${c} 0 A ${r} ${r} 0 1 1 ${c} ${s} A ${r} ${r} 0 1 1 ${c} 0 Z`
      : `M ${r} 0 A ${r} ${r} 0 0 1 ${s} ${r} A ${r} ${r} 0 0 1 ${r} ${s} L 0 ${s} L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  const turn = `transform="rotate(-45 ${c} ${c})"`;
  const colors = fills.map(escapeSvg);
  const cover = `x="${-s}" y="${-s}" width="${3 * s}" height="${3 * s}"`;
  const slices =
    colors.length === 1
      ? `<rect ${cover} style="fill:${colors[0]}"/>`
      : sliceWedges(colors.length, c, s)
          .map((d, i) => `<path d="${d}" style="fill:${colors[i]}"/>`)
          .join("");
  const wash =
    veil === undefined
      ? ""
      : `<rect ${cover} fill="#fff" fill-opacity="${veil}"/>`;
  // Twice as wide, clipped to the shape: the outline sits inside the box.
  const border = `<path d="${outline}" ${turn} fill="none" style="stroke:${escapeSvg(ring)}" stroke-width="${2 * OUTLINE_PX}"/>`;
  const head =
    `<g filter="url(#${id}h)"><g clip-path="url(#${id}c)">` +
    `${slices}${wash}${border}</g></g>`;
  let glyph = "";
  if (icon !== undefined) {
    const p = icon.sizePx;
    const ink = escapeSvg(icon.ink);
    glyph =
      `<svg x="${c - p / 2}" y="${c - p / 2}" width="${p}" height="${p}" viewBox="${escapeSvg(icon.markup.viewBox)}" style="color:${ink};fill:${ink}" overflow="visible"` +
      `${icon.shadow === true ? ` filter="url(#${id}i)"` : ""}>${icon.markup.body}</svg>`;
  }
  const defs =
    `<defs><clipPath id="${id}c"><path d="${outline}" ${turn}/></clipPath>` +
    // Tailwind's `shadow-md` under the head.
    `<filter id="${id}h" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feDropShadow dx="0" dy="4" stdDeviation="2.5" flood-color="#000" flood-opacity="0.1"/>` +
    `<feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#000" flood-opacity="0.1"/></filter>` +
    // Keeps a light glyph readable where two slices meet.
    (icon?.shadow === true
      ? `<filter id="${id}i" x="-50%" y="-50%" width="200%" height="200%">` +
        `<feDropShadow dx="0" dy="0" stdDeviation="0.75" flood-color="#000" flood-opacity="0.45"/>` +
        `<feDropShadow dx="0" dy="1" stdDeviation="0.5" flood-color="#000" flood-opacity="0.25"/></filter>`
      : "") +
    `</defs>`;
  return `${defs}${head}${glyph}`;
}
