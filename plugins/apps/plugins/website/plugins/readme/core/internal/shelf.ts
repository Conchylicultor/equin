import { APPS } from "@plugins/apps/plugins/website/plugins/pages/plugins/apps/core";
import {
  oklchCss,
  websiteTileStops,
} from "@plugins/apps/plugins/website/plugins/app-tiles/core";
import { FONT, INK, REDUCED_MOTION, esc, f1 } from "./style";

/** The widest label, in characters, kept on one line under a tile. */
const LABEL_CHARS = 10;

/** A name on one line, or broken at its spaces into two when it is too wide for its tile. */
function label(name: string): string[] {
  if (name.length <= LABEL_CHARS || !name.includes(" ")) return [name];
  const words = name.split(" ");
  let best = 1;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(" ").length;
    const b = words.slice(k).join(" ").length;
    const bestA = words.slice(0, best).join(" ").length;
    const bestB = words.slice(best).join(" ").length;
    if (Math.max(a, b) < Math.max(bestA, bestB)) best = k;
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

/** An icon's drawing in its 24 × 24 box (an Iconify `body`), by Material Symbols name. */
export type GlyphBody = (name: string) => string;

/**
 * The app shelf under the banner: every app equin ships (the website's apps
 * catalog, the ones not built yet left out), each its website tile — its glyph
 * on its colour's deep-to-base gradient — popping in one after the other.
 */
export function shelfSvg(glyph: GlyphBody): string {
  const apps = APPS.filter((a) => !a.soon);
  const W = 1200;
  const H = 160;
  const S = 56;
  const step = (W - 40) / apps.length;
  const tiles = apps.map((app, i) => {
    const cx = 20 + step * i + step / 2;
    const x = cx - S / 2;
    const y = 22;
    const { deep, base } = websiteTileStops(app.color);
    const g = 14 / 12; // the 24-unit glyph drawn 28 px wide
    return `<g class="pop" style="animation-delay:${(i * 0.07).toFixed(2)}s; transform-origin:${f1(cx)}px ${y + S / 2}px">
  <defs><linearGradient id="shelf-t${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${oklchCss(deep)}"/><stop offset="1" stop-color="${oklchCss(base)}"/></linearGradient></defs>
  <rect x="${f1(x)}" y="${y}" width="${S}" height="${S}" rx="15" fill="url(#shelf-t${i})"/>
  <g transform="translate(${f1(cx - 14)} ${y + S / 2 - 14}) scale(${g.toFixed(4)})" fill="#fff">${glyph(app.icon.name).replace(/fill="currentColor"/g, "")}</g>
  <text x="${f1(cx)}" y="${y + S + 24}" text-anchor="middle" class="n">${label(
    app.name,
  )
    .map(
      (line, k) =>
        `<tspan x="${f1(cx)}" dy="${k ? 15 : 0}">${esc(line)}</tspan>`,
    )
    .join("")}</text>
</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
  text { ${FONT} } .n { font-size: 13px; fill: ${INK.muted}; }
  .pop { animation: pop .6s cubic-bezier(.3,1.6,.5,1) both; }
  @keyframes pop { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: none; } }
  ${REDUCED_MOTION}
</style>
${tiles.join("\n")}
</svg>
`;
}
