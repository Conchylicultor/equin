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
  /**
   * The logo draws itself in (`LOGO.draw`), starting `delayS` seconds after the
   * document loads. CSS only, so it plays wherever the SVG is shown — an
   * `<img>` included — and a renderer without CSS (a rasterizer) draws the
   * logo whole. Under `prefers-reduced-motion` it is whole from the start.
   */
  draw?: { delayS: number };
};

/** What {@link logoMarkSvg} takes: the drawn mark alone, no document around it. */
export type LogoMarkOptions = Pick<
  LogoSvgOptions,
  "master" | "paint" | "draw"
> & {
  /**
   * Prefixes the ids and class names the mark defines, so several marks (or a
   * mark and the document around it) never collide.
   */
  idPrefix: string;
};

type Parts = { defs: string[]; mark: string };

function markParts(o: LogoMarkOptions): Parts {
  const defs: string[] = [];
  let stroke: string = o.paint;
  if (o.paint === "gradient") {
    const g = LOGO.gradient;
    const id = `${o.idPrefix}gradient`;
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}"><stop offset="0" stop-color="${g.from}"/><stop offset="1" stop-color="${g.to}"/></linearGradient>`,
    );
    stroke = `url(#${id})`;
  }
  let drawAttrs = "";
  if (o.draw) {
    const d = LOGO.draw;
    const cls = `${o.idPrefix}draw`;
    // pathLength="1" makes the dash one line-length, whatever the master.
    defs.push(
      `<style>.${cls}{stroke-dasharray:1;stroke-dashoffset:1;animation:${cls} ${d.durationS}s ${d.easing} ${o.draw.delayS}s forwards}` +
        `@keyframes ${cls}{to{stroke-dashoffset:0}}` +
        `@media (prefers-reduced-motion: reduce){.${cls}{animation:none;stroke-dashoffset:0}}</style>`,
    );
    drawAttrs = ` pathLength="1" class="${cls}"`;
  }
  return {
    defs,
    mark: `<path d="${logoPath(o.master)}"${drawAttrs} stroke="${stroke}" stroke-width="${fmt(logoStroke(o.master))}" stroke-linecap="round" stroke-linejoin="round"/>`,
  };
}

/**
 * The logo as a fragment to place inside another SVG (a banner, a card): a
 * `<g>` in the 100 × 100 logo box, carrying its own defs. Position it with a
 * transform on a group around it.
 */
export function logoMarkSvg(o: LogoMarkOptions): string {
  const { defs, mark } = markParts(o);
  return `<g fill="none">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${mark}</g>`;
}

/** The logo as a standalone SVG document — what every generated file holds. */
export function logoSvg(o: LogoSvgOptions): string {
  const { defs, mark: line } = markParts({ ...o, idPrefix: "logo-" });
  const body: string[] = [];
  let mark = line;
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
