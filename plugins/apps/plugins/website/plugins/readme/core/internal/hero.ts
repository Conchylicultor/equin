import { LOGO, logoMarkSvg } from "@plugins/ui/plugins/logo/core";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import { FONT, INK, REDUCED_MOTION, esc, f1 } from "./style";

const W = 1200;
const H = 440;
const BLUE = LOGO.gradient.from;
const VIOLET = LOGO.gradient.to;

type Node = {
  x: number;
  y: number;
  /** Side of the block. */
  s: number;
  /** Painted in the brand gradient (else a dark card). */
  lit: boolean;
  /** The block it hangs from, -1 for a root. */
  parent: number;
  /** Its drift: a small ellipse (radii), a phase and a period. */
  ax: number;
  ay: number;
  ph: number;
  dur: number;
  /** A short-lived leaf's cycle: it sprouts, lives and withers, again and again. */
  life?: { period: number; delay: number };
};

const CORE_BLOCKS = 14;
const LEAVES = 6;
/** No two core blocks closer than this; a leaf keeps LEAF_GAP from every block. */
const MIN_GAP = 64;
const LEAF_GAP = 44;
/** Each drift loop is drawn through this many points (SMIL `values`). */
const SAMPLES = 16;
/** The build-in: one block every BUILD_STEP seconds, from BUILD_START. */
const BUILD_START = 0.5;
const BUILD_STEP = 0.11;
/** The signal: one hop per edge, then a rest. */
const HOP = 0.9;
const REST = 9;

/**
 * The plugin network beside the logo, alive:
 *  1. On load it builds itself: blocks pop in breadth-first from the roots, each
 *     wire drawing out of its parent just before its child appears.
 *  2. Then it lives: every block drifts on its own small loop, its wires
 *     following (SMIL, endpoint by endpoint, so they stay attached); short-lived
 *     leaves sprout and wither, each on its own cycle (periods spread so the
 *     pattern never visibly repeats); and now and then a faint signal runs
 *     outward along the core tree, one edge at a time.
 * Deterministic: the same seed draws the same network.
 */
function network(seed: number): { svg: string; css: string } {
  const rand = mulberry32(seed);
  const nodes: Node[] = [];
  const mk = (x: number, y: number, parent: number): Node => ({
    x,
    y,
    parent,
    s: 9 + rand() * 13,
    lit: rand() < 0.33,
    ax: 3 + rand() * 5,
    ay: 3 + rand() * 5,
    ph: rand() * Math.PI * 2,
    dur: 7 + rand() * 6,
  });
  const free = (x: number, y: number, gap: number) =>
    nodes.every((n) => Math.hypot(x - n.x, y - n.y) >= gap);
  for (let tries = 0; nodes.length < CORE_BLOCKS && tries < 2000; tries++) {
    const x = 860 + rand() * 300;
    const y = 40 + rand() * 360;
    if (!free(x, y, MIN_GAP)) continue;
    let best = -1;
    let bd = Infinity;
    nodes.forEach((n, j) => {
      const d = Math.hypot(x - n.x, y - n.y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    });
    nodes.push(mk(x, y, bd < 160 ? best : -1));
  }
  const core = nodes.length;
  for (let tries = 0; nodes.length < core + LEAVES && tries < 2000; tries++) {
    const p = Math.floor(rand() * core);
    const a = rand() * Math.PI * 2;
    const r = 45 + rand() * 30;
    const x = nodes[p]!.x + r * Math.cos(a);
    const y = nodes[p]!.y + r * Math.sin(a);
    if (x < 840 || x > 1175 || y < 24 || y > 416 || !free(x, y, LEAF_GAP))
      continue;
    const n = mk(x, y, p);
    n.s = 7 + rand() * 9;
    n.life = { period: 9 + rand() * 10, delay: 3.5 + rand() * 7 };
    nodes.push(n);
  }

  const ks = [...Array(SAMPLES + 1).keys()];
  const at = (n: Node, k: number): [number, number] => {
    const a = n.ph + (2 * Math.PI * k) / SAMPLES;
    return [n.x + n.ax * Math.cos(a), n.y + n.ay * Math.sin(a)];
  };
  const track = (attr: string, n: Node, axis: 0 | 1) =>
    `<animate attributeName="${attr}" dur="${f1(n.dur)}s" repeatCount="indefinite" values="${ks.map((k) => f1(at(n, k)[axis])).join(";")}"/>`;

  // Build order: breadth-first over the core tree.
  const appearAt = new Map<number, number>();
  const signalOrder: number[] = [];
  const queue = nodes
    .map((n, i) => (i < core && n.parent === -1 ? i : -1))
    .filter((i) => i >= 0);
  let step = 0;
  for (const r of queue) appearAt.set(r, BUILD_START + step++ * BUILD_STEP);
  while (queue.length) {
    const i = queue.shift()!;
    nodes.forEach((n, c) => {
      if (c < core && n.parent === i) {
        signalOrder.push(c);
        appearAt.set(c, BUILD_START + step++ * BUILD_STEP);
        queue.push(c);
      }
    });
  }
  const built = BUILD_START + step * BUILD_STEP;
  const cycle = signalOrder.length * HOP + REST;
  const hopPct = ((HOP * 1.6) / cycle) * 100;

  const css: string[] = [
    `.wire { stroke: ${INK.border}; stroke-width: 1.2; stroke-dasharray: 1 1; }`,
    `.blk { transform-box: fill-box; transform-origin: center; }`,
    `.spark { stroke: ${VIOLET}; stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: .22 1.5; stroke-dashoffset: .22; opacity: 0; animation: spark ${cycle.toFixed(2)}s linear infinite backwards; }`,
    `@keyframes draw-wire { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }`,
    `@keyframes pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }`,
    `@keyframes spark { 0% { stroke-dashoffset: .22; opacity: 0; } ${(hopPct * 0.15).toFixed(2)}% { opacity: .8; } ${(hopPct * 0.85).toFixed(2)}% { opacity: .8; } ${hopPct.toFixed(2)}% { stroke-dashoffset: -1; opacity: 0; } 100% { stroke-dashoffset: -1; opacity: 0; } }`,
  ];
  const lines: string[] = [];
  const blocks: string[] = [];
  nodes.forEach((n, c) => {
    let wireAnim: string;
    let blockAnim: string;
    if (n.life) {
      // Wire grows, block pops, lives, block shrinks, wire pulls back into its parent.
      css.push(
        `@keyframes w${c} { 0% { stroke-dashoffset: 1; } 4% { stroke-dashoffset: 0; } 70% { stroke-dashoffset: 0; } 76%, 100% { stroke-dashoffset: 1; } }`,
        `@keyframes n${c} { 0%, 3% { transform: scale(0); opacity: 0; } 7% { transform: scale(1); opacity: 1; } 68% { transform: scale(1); opacity: 1; } 72%, 100% { transform: scale(0); opacity: 0; } }`,
      );
      const timing = `${f1(n.life.period)}s ease-in-out ${f1(n.life.delay)}s infinite backwards`;
      wireAnim = `animation: w${c} ${timing}`;
      blockAnim = `animation: n${c} ${timing}`;
    } else {
      const t = appearAt.get(c)!;
      wireAnim = `animation: draw-wire .45s ease-out ${(t - 0.3).toFixed(2)}s backwards`;
      blockAnim = `animation: pop .5s cubic-bezier(.3,1.6,.5,1) ${t.toFixed(2)}s backwards`;
    }
    if (n.parent >= 0) {
      const p = nodes[n.parent]!;
      const [x1, y1] = at(p, 0);
      const [x2, y2] = at(n, 0);
      const ends = `x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"`;
      const follow =
        track("x1", p, 0) +
        track("y1", p, 1) +
        track("x2", n, 0) +
        track("y2", n, 1);
      lines.push(
        `<line ${ends} pathLength="1" class="wire" style="${wireAnim}">${follow}</line>`,
      );
      const k = signalOrder.indexOf(c);
      if (k >= 0)
        lines.push(
          `<line ${ends} pathLength="1" class="spark" style="animation-delay:${(built + 2 + k * HOP).toFixed(2)}s">${follow}</line>`,
        );
    }
    const drift = `<animateTransform attributeName="transform" type="translate" dur="${f1(n.dur)}s" repeatCount="indefinite" values="${ks
      .map((k) => {
        const [px, py] = at(n, k);
        return `${f1(px - n.x)},${f1(py - n.y)}`;
      })
      .join(";")}"/>`;
    const fill = n.lit
      ? `fill="url(#hero-g)" stroke="none"`
      : `fill="${INK.card}" stroke="${INK.border}"`;
    blocks.push(
      `<g>${drift}<rect x="${f1(n.x - n.s / 2)}" y="${f1(n.y - n.s / 2)}" width="${f1(n.s)}" height="${f1(n.s)}" rx="${f1(n.s / 4)}" ${fill} class="blk" style="${blockAnim}"/></g>`,
    );
  });
  return {
    svg: `<g>${lines.join("")}</g><g>${blocks.join("")}</g>`,
    css: css.join("\n  "),
  };
}

/** The README's banner: the logo drawing itself in, the name, the tagline, the living network. */
export function heroSvg(): string {
  const net = network(11);
  const tagline = [
    "A self-evolving, personal operating system",
    "for the agentic era.",
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="hero-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="${VIOLET}"/></linearGradient>
  <radialGradient id="hero-glow" cx="0.22" cy="0.5" r="0.6"><stop offset="0" stop-color="${VIOLET}" stop-opacity="0.28"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/></radialGradient>
  <radialGradient id="hero-glow2" cx="0.8" cy="0.4" r="0.5"><stop offset="0" stop-color="${BLUE}" stop-opacity="0.18"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></radialGradient>
  <pattern id="hero-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="${INK.border}"/></pattern>
  <linearGradient id="hero-fade" x1="0" x2="1"><stop offset="0.35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
  <mask id="hero-m"><rect width="${W}" height="${H}" fill="url(#hero-fade)"/></mask>
  <clipPath id="hero-clip"><rect width="${W}" height="${H}" rx="16"/></clipPath>
</defs>
<style>
  text { ${FONT} }
  .word { font-size: 104px; font-weight: 700; letter-spacing: -4px; fill: ${INK.fg}; }
  .tag { font-size: 26px; fill: ${INK.muted}; }
  .rise { opacity: 0; animation: rise 1s ease-out forwards; }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  ${net.css}
  ${REDUCED_MOTION}
  @media (prefers-reduced-motion: reduce) { .rise { opacity: 1; } }
</style>
<g clip-path="url(#hero-clip)">
  <rect width="${W}" height="${H}" fill="${INK.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#hero-dots)" mask="url(#hero-m)" opacity=".7"/>
  <rect width="${W}" height="${H}" fill="url(#hero-glow)"/>
  <rect width="${W}" height="${H}" fill="url(#hero-glow2)"/>
  ${net.svg}
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="none" stroke="${INK.border}"/>
<g transform="translate(70 120) scale(2)">${logoMarkSvg({ master: "full", paint: "gradient", draw: { delayS: 0.2 }, idPrefix: "hero-logo-" })}</g>
<g class="rise" style="animation-delay:.9s"><text x="300" y="206" class="word">equin</text></g>
<g class="rise" style="animation-delay:1.3s"><text x="304" y="256" class="tag">${esc(tagline[0]!)}</text><text x="304" y="290" class="tag">${esc(tagline[1]!)}</text></g>
</svg>
`;
}
