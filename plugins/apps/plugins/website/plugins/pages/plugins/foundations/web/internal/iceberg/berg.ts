import {
  bergPoints,
  hwFor,
  polyStr,
  stripBg,
  unitY,
  type Point,
} from "./geometry";

/** A gradient stop painted from the scene's palette (`iceberg.css`), so no colour is spelled here. */
const stop = (offset: string | number, color: string, opacity?: number) =>
  `<stop offset="${offset}" style="stop-color:var(${color})${opacity === undefined ? "" : `;stop-opacity:${opacity}`}"/>`;

/** The whole page-sized artwork: the ice below the water, the ice above it, and the waterline. */
function bergSvg({
  W,
  H,
  pts,
  water,
  at,
}: {
  W: number;
  H: number;
  pts: readonly Point[];
  water: number;
  at: (f: number) => string;
}): string {
  const poly = polyStr(pts);
  return `<defs><clipPath id="ca"><rect x="0" y="0" width="${W}" height="${water}"/></clipPath><clipPath id="cb"><rect x="0" y="${water}" width="${W}" height="${H}"/></clipPath>
    <linearGradient id="above" x1="0" y1="0" x2="1" y2="0">${stop(0, "--berg-ice-top-0")}${stop(0.55, "--berg-ice-top-1")}${stop(1, "--berg-ice-top-2")}</linearGradient>
    <linearGradient id="below" x1="0" y1="${water}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">${stop(0, "--berg-ice-0", 0.5)}${stop(at(0.3), "--berg-ice-1", 0.16)}${stop(at(0.7), "--berg-ice-2", 0.07)}${stop(1, "--berg-ice-3", 0)}</linearGradient>
    <linearGradient id="rim" x1="0" y1="${water}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">${stop(0, "--berg-rim-0", 0.95)}${stop(at(0.4), "--berg-rim-1", 0.4)}${stop(1, "--berg-rim-2", 0.03)}</linearGradient>
    <linearGradient id="wl" x1="0" y1="0" x2="1" y2="0">${stop(0, "--berg-blue", 0)}${stop(0.3, "--berg-blue")}${stop(0.7, "--berg-cyan")}${stop(1, "--berg-cyan", 0)}</linearGradient>
    </defs>
    <polygon class="ice" points="${poly}" fill="url(#below)" stroke="url(#rim)" stroke-width="1.2" clip-path="url(#cb)"/>
    <polygon class="ice-top" points="${poly}" fill="url(#above)" style="stroke:var(--berg-ice-outline)" stroke-width="1.2" clip-path="url(#ca)"/>
    <rect class="wl" x="0" y="${water}" width="${W}" height="1" fill="url(#wl)" opacity=".8"/>`;
}

/**
 * Draw the berg behind `host` (position: relative), keyed to its layer blocks:
 * one `<svg>` strip per layer, each a window (viewBox) onto the same page-sized
 * drawing. A strip is stretched / moved with a transform when its layer grows
 * or moves, so a glide never repaints the berg. Each strip carries its own sky
 * or sea, keyed to its own layer, so nothing on screen changes colour when the
 * page grows or shrinks.
 */
export function drawBergIn(
  host: HTMLElement,
  box: HTMLElement,
  blocks: readonly HTMLElement[],
  {
    M,
    tipOffset,
    idPrefix,
  }: {
    M: number;
    tipOffset: number;
    /** Unique per scene, so two scenes' gradient ids never collide. */ idPrefix: string;
  },
): void {
  const second = blocks[1];
  const last = blocks[blocks.length - 1];
  if (!second || !last)
    throw new Error("iceberg: the berg needs at least two layers");
  const water = second.offsetTop;
  host.style.setProperty("--water", water + "px");
  // Measure the host without the berg: its old height would count itself.
  box.style.height = "0px";
  const W = host.clientWidth;
  const H = host.scrollHeight;
  box.style.height = H + "px";
  const HW = hwFor(W);
  const keys: Point[] = blocks.map((b, i) => [
    i === 0 ? b.offsetTop + tipOffset : b.offsetTop,
    (HW[i] ?? 0) * M,
  ]);
  keys.push([last.offsetTop + 170, 0.08 * M]);
  const pts = bergPoints({ W, M, keys, tailY: last.offsetTop + 200 });
  const cuts = [0, ...blocks.slice(1).map((b) => b.offsetTop), H];
  // the ice's fades run from the waterline (unit 1) to the end (the last unit), placed by layer, not by pixel
  const n = cuts.length - 1;
  const at = (f: number) =>
    ((unitY(cuts, 1 + f * (n - 1)) - water) / (H - water)).toFixed(4);
  const art = bergSvg({ W, H, pts, water, at });
  box.innerHTML = cuts
    .slice(0, -1)
    .map((y0, i) => {
      // each strip reaches 2px into the next (which is drawn over it), so a strip boundary landing on a
      // fractional pixel mid-glide can never open a hairline gap onto the scene behind
      const h = (cuts[i + 1] ?? y0) - y0 + (i < n - 1 ? 2 : 0);
      const own = art
        .replace(/id="([\w-]+)"/g, `id="$1-${idPrefix}${i}"`)
        .replace(/url\(#([\w-]+)\)/g, `url(#$1-${idPrefix}${i})`);
      return `<svg class="iceberg-band" data-b="${i}" style="top:${y0}px;height:${h}px;background:${stripBg(i, n)}" viewBox="0 ${y0} ${W} ${h}" preserveAspectRatio="none">${own}</svg>`;
    })
    .join("");
}
