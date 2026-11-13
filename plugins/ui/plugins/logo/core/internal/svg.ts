import {
  LOGO,
  assertDotClear,
  fmt,
  logoPath,
  logoStroke,
  type Dot,
  type LogoMaster,
} from "./geometry";

/** The least room, in view-box units, between the attention dot and the line. */
const DOT_GAP = 6;

export type LogoSvgOptions = {
  master: LogoMaster;
  /** The line's paint: the brand gradient, the text colour, or one colour. */
  paint: "gradient" | "currentColor" | `#${string}`;
  /** The `width`/`height` attributes (the view box is always 100 × 100). */
  size: number;
  /** A rounded tile behind the logo, the logo scaled into its middle. */
  tile?: { fill: `#${string}`; inset: number; radius: number; scale: number };
  /** A dot in the outer arc's open (top-left) quarter, the logo left whole. */
  attention?: { dot: Dot; fill: `#${string}` };
};

/** The logo as a standalone SVG document — what every generated file holds. */
export function logoSvg(o: LogoSvgOptions): string {
  const defs: string[] = [];
  const body: string[] = [];
  let stroke: string = o.paint;
  if (o.paint === "gradient") {
    const g = LOGO.gradient;
    defs.push(
      `<linearGradient id="logo-gradient" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}"><stop offset="0" stop-color="${g.from}"/><stop offset="1" stop-color="${g.to}"/></linearGradient>`,
    );
    stroke = "url(#logo-gradient)";
  }
  let mark = `<path d="${logoPath(o.master)}" stroke="${stroke}" stroke-width="${fmt(logoStroke(o.master))}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (o.tile) {
    const t = o.tile;
    body.push(
      `<rect x="${t.inset}" y="${t.inset}" width="${100 - 2 * t.inset}" height="${100 - 2 * t.inset}" rx="${t.radius}" fill="${t.fill}"/>`,
    );
    const shift = fmt(50 * (1 - t.scale));
    mark = `<g transform="translate(${shift} ${shift}) scale(${t.scale})">${mark}</g>`;
  }
  body.push(mark);
  if (o.attention) {
    const d = o.attention.dot;
    assertDotClear(o.master, d, DOT_GAP);
    body.push(
      `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="${o.attention.fill}"/>`,
    );
  }
  return (
    `<svg width="${o.size}" height="${o.size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
    body.join("") +
    `</svg>\n`
  );
}
