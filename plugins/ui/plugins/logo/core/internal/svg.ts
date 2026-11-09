import {
  LOGO,
  arcStartClearing,
  fmt,
  logoPath,
  logoStroke,
  type Knockout,
  type LogoMaster,
} from "./geometry";

export type LogoSvgOptions = {
  master: LogoMaster;
  /** The line's paint: the brand gradient, the text colour, or one colour. */
  paint: "gradient" | "currentColor" | `#${string}`;
  /** The `width`/`height` attributes (the view box is always 100 × 100). */
  size: number;
  /** A rounded tile behind the logo, the logo scaled into its middle. */
  tile?: { fill: `#${string}`; inset: number; radius: number; scale: number };
  /** A dot in a cut-out at the top-right, the arc trimmed to clear it. */
  attention?: { knockout: Knockout; dotRadius: number; dotFill: `#${string}` };
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
  const start = o.attention
    ? arcStartClearing(o.master, o.attention.knockout)
    : LOGO.arcStartDeg;
  let mark = `<path d="${logoPath(o.master, start)}" stroke="${stroke}" stroke-width="${fmt(logoStroke(o.master))}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (o.attention) {
    const k = o.attention.knockout;
    defs.push(
      `<mask id="logo-knockout"><rect width="100" height="100" fill="#ffffff"/><circle cx="${k.cx}" cy="${k.cy}" r="${k.r}" fill="#000000"/></mask>`,
    );
    mark = `<g mask="url(#logo-knockout)">${mark}</g>`;
  }
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
    const k = o.attention.knockout;
    body.push(
      `<circle cx="${k.cx}" cy="${k.cy}" r="${o.attention.dotRadius}" fill="${o.attention.dotFill}"/>`,
    );
  }
  return (
    `<svg width="${o.size}" height="${o.size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
    body.join("") +
    `</svg>\n`
  );
}
