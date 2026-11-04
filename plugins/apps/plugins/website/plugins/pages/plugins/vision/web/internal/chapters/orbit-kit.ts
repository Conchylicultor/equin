import { n1, random, smooth, smoothPath, type Pt } from "../kit/math";
import { gpath, grect, type OsKind } from "../kit/night";
import { C, OS_COL } from "../kit/palette";
import { circ, rect } from "../kit/svg";

/**
 * Orbits: the visual language of chapters 3 to 5 — apps floating on a slowly
 * turning sphere, and an app as the plain shape it reads as from far away.
 */

export interface Projected {
  x: number;
  y: number;
  z: number;
  /** Perspective scale. */
  f: number;
}
export interface Sphere {
  (lon: number, lat: number, rot: number): Projected;
  /** The path of one ring of latitude. */
  ring(lat: number): string;
}

/**
 * A projection for a sphere of radius R (RX stretches it sideways), tilted
 * TILT, seen from D, centred at (0, CY).
 */
export function sphere(o: {
  R: number;
  RX?: number;
  CY?: number;
  D: number;
  TILT: number;
}): Sphere {
  const { R, D } = o;
  const RX = o.RX ?? 1;
  const CY = o.CY ?? 0;
  const c = Math.cos(o.TILT);
  const s = Math.sin(o.TILT);
  const proj = ((lon: number, lat: number, rot: number) => {
    const a = lon + rot;
    const x = RX * R * Math.cos(lat) * Math.sin(a);
    const y = -R * Math.sin(lat);
    const z = R * Math.cos(lat) * Math.cos(a);
    const y2 = y * c + z * s;
    const z2 = z * c - y * s;
    const f = D / (D - z2);
    return { x: x * f, y: CY + y2 * f, z: z2, f };
  }) as Sphere;
  proj.ring = (lat) => {
    let d = "";
    for (let i = 0; i <= 72; i++) {
      const q = proj((i * Math.PI) / 36, lat, 0);
      d += `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    }
    return d;
  };
  return proj;
}

/**
 * A person as chapter 5 draws them (its units): a halo, three dots on a small
 * orbit; and when, leaving chapter 4, an orbit has become one.
 */
export const NODE = {
  halo: 30,
  dot: 5.5,
  orbit: 12,
  fade: (p: number): number => smooth((p - 4.15) / 0.5),
};

// ---- a plain app, generated ----
// A title bar (with or without its dots or a pill), maybe a side pane (left or right, of rows, icons or
// lines), maybe a footer with buttons, and a body cut into one to three cells, each showing one thing in
// one bold gesture, in its own colour (and sometimes a second one). It is drawn like the windows of
// chapter 3 — the same dark ground and outline, its content quieter than its frame — so an app reads
// with the same strength at every step of the zoom.

type Cell =
  | "lines"
  | "grid"
  | "list"
  | "bubbles"
  | "keys"
  | "kpi"
  | "cal"
  | "ring"
  | Graph;
type Graph = "chart" | "bars" | "image";
/** What a cell shows, and how often. Graphs are kept apart: about one app in five shows one, never more. */
const CELLS: readonly [Cell, number][] = [
  ["lines", 3],
  ["grid", 2],
  ["list", 2],
  ["bubbles", 1.5],
  ["keys", 0.6],
  ["kpi", 1],
  ["cal", 1],
  ["ring", 1],
];
const GRAPHS: readonly Graph[] = ["chart", "bars", "image"];
const GRAPHED = 0.22;
const CELL_SUM = CELLS.reduce((a, [, w]) => a + w, 0);
const LEAD: Record<OsKind, Cell> = {
  doc: "lines",
  chat: "bubbles",
  grid: "grid",
  list: "list",
  chart: "chart",
  keys: "keys",
};

/**
 * An app as a plain shape — what it reads as from far away — generated from
 * its seed, so no two apps look alike (`kind`, if given, leads its first cell).
 * Centred on (0, 0), W × H.
 */
export function simpleApp(
  col: string,
  W: number,
  H: number,
  seed: number,
  kind?: OsKind,
): string {
  const rnd = random(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const between = (a: number, b: number) => a + (b - a) * rnd();
  // every measure in proportion to the app's size, so the same app drawn at two sizes looks the same
  const x = -W / 2;
  const y = -H / 2;
  const u = Math.min(W, H);
  const r = u * 0.12;
  const DIM = C.dim;
  const col2 = rnd() < 0.45 ? pick(OS_COL) : col;
  const pickCell = (): Cell => {
    let v = rnd() * CELL_SUM;
    for (const [k, w] of CELLS) {
      v -= w;
      if (v <= 0) return k;
    }
    return "lines";
  };
  const fill = (c: string, op: string) => `fill="${c}" opacity="${op}"`;
  const box = (
    bx: number,
    by: number,
    bw: number,
    bh: number,
    c: string,
    op: string,
    rr?: number,
  ) =>
    rect(
      n1(bx),
      n1(by),
      n1(Math.max(1, bw)),
      n1(Math.max(1, bh)),
      "zb-dot",
      n1(rr ?? Math.min(bw, bh) * 0.2),
      fill(c, op),
    );
  let o =
    rect(n1(x), n1(y), n1(W), n1(H), "zb-pop", n1(r)) + '<g opacity=".6">';
  // the title bar
  const bar = H * between(0.15, 0.22);
  const top = y + bar;
  o += `<path class="zb-l" stroke="${col}" opacity=".5" d="M${n1(x)} ${n1(top)}h${n1(W)}"/>`;
  const bk = rnd();
  if (bk < 0.4)
    o +=
      circ(
        n1(x + bar * 0.55),
        n1(y + bar / 2),
        n1(bar * 0.16),
        "zb-dot",
        fill(col, "1"),
      ) +
      circ(
        n1(x + bar * 1.05),
        n1(y + bar / 2),
        n1(bar * 0.16),
        "zb-dot",
        fill(col, ".6"),
      );
  else if (bk < 0.7)
    o += box(
      x + W - bar * 2.4,
      y + bar * 0.28,
      bar * 1.8,
      bar * 0.44,
      col2,
      ".6",
      bar * 0.22,
    );
  else if (bk < 0.85)
    o += box(
      x + W / 2 - W * 0.15,
      y + bar * 0.38,
      W * 0.3,
      bar * 0.24,
      DIM,
      ".8",
      bar * 0.12,
    );
  // the side pane
  let bx = x;
  let bw = W;
  let by = top;
  let bh = y + H - top;
  if (rnd() < 0.5) {
    const sw = W * between(0.2, 0.32);
    const left = rnd() < 0.7;
    const sx = left ? x : x + W - sw;
    const sk = rnd();
    const rows = 3 + Math.floor(rnd() * 3);
    o += `<path class="zb-l" stroke="${col}" opacity=".35" d="M${n1(left ? x + sw : sx)} ${n1(top)}V${n1(y + H)}"/>`;
    for (let i = 0; i < rows; i++) {
      const ry = top + (i + 0.8) * (bh / (rows + 0.6));
      const on = i === Math.floor(rows / 3);
      if (sk < 0.45)
        o +=
          circ(
            n1(sx + sw * 0.22),
            n1(ry),
            n1(u * 0.025 + 0.6),
            "zb-dot",
            fill(on ? col : DIM, "1"),
          ) +
          box(
            sx + sw * 0.36,
            ry - u * 0.012,
            sw * between(0.3, 0.5),
            u * 0.024,
            on ? col : DIM,
            ".8",
            0,
          );
      else if (sk < 0.75)
        o += box(
          sx + sw * 0.25,
          ry - sw * 0.14,
          sw * 0.28,
          sw * 0.28,
          on ? col : DIM,
          on ? ".7" : ".45",
        );
      else
        o += box(
          sx + sw * 0.15,
          ry - u * 0.012,
          sw * between(0.45, 0.7),
          u * 0.024,
          on ? col : DIM,
          ".8",
          0,
        );
    }
    bw -= sw;
    if (left) bx += sw;
  }
  // the footer
  if (rnd() < 0.28) {
    const fh = H * 0.15;
    o +=
      `<path class="zb-l" stroke="${DIM}" opacity=".5" d="M${n1(bx)} ${n1(y + H - fh)}h${n1(bw)}"/>` +
      box(
        bx + bw - bw * 0.3,
        y + H - fh * 0.75,
        bw * 0.24,
        fh * 0.5,
        col,
        ".7",
        fh * 0.25,
      ) +
      (rnd() < 0.5
        ? box(
            bx + bw - bw * 0.52,
            y + H - fh * 0.75,
            bw * 0.17,
            fh * 0.5,
            DIM,
            ".6",
            fh * 0.25,
          )
        : "");
    bh -= fh;
  }
  // the body, in cells
  const pad = u * 0.07;
  bx += pad;
  by += pad;
  bw -= 2 * pad;
  bh -= 2 * pad;
  const n = rnd() < 0.4 ? 1 : rnd() < 0.75 ? 2 : 3;
  const across = bw > bh * 1.2 ? rnd() < 0.8 : rnd() < 0.3;
  const cells: [number, number, number, number][] = [];
  let at = 0;
  const gap = pad * 0.8;
  const cuts =
    n === 1
      ? [1]
      : n === 2
        ? [between(0.35, 0.65)]
        : [between(0.25, 0.4), between(0.25, 0.4)];
  if (n > 1) cuts.push(1 - cuts.reduce((a, b) => a + b, 0));
  const len = (across ? bw : bh) - gap * (n - 1);
  for (const c of cuts) {
    const s = len * c;
    cells.push(across ? [bx + at, by, s, bh] : [bx, by + at, bw, s]);
    at += s + gap;
  }
  const led = kind ? LEAD[kind] : undefined;
  let graphAt =
    led && (GRAPHS as readonly Cell[]).includes(led)
      ? -1
      : rnd() < GRAPHED
        ? Math.floor(rnd() * cells.length)
        : -1;
  if (led && graphAt === 0) graphAt = -1;
  cells.forEach((cl, j) => {
    const type: Cell =
      j === 0 && led ? led : j === graphAt ? pick(GRAPHS) : pickCell();
    o += cell(type, cl[0], cl[1], cl[2], cl[3], j === 1 ? col2 : col);
  });
  return o + "</g>" + grect(x, y, W, H, r, col);

  function cell(
    type: Cell,
    cx: number,
    cy: number,
    cw: number,
    ch: number,
    c: string,
  ): string {
    let s = "";
    let d = "";
    const m = Math.min(cw, ch);
    if (cw < 4 || ch < 4) return "";
    switch (type) {
      case "lines": {
        const k = 2 + Math.floor(rnd() * 3);
        s += box(
          cx,
          cy,
          cw * between(0.4, 0.7),
          Math.max(1.5, ch * 0.1),
          c,
          ".9",
          0,
        );
        for (let i = 1; i <= k; i++)
          d += `M${n1(cx)} ${n1(cy + ch * (0.12 + (0.8 * i) / k))}h${n1(cw * between(0.5, 1))}`;
        s += gpath(d, DIM);
        break;
      }
      case "chart": {
        // a random walk with a drift, drawn smooth
        const k = 4 + Math.floor(rnd() * 2);
        let v = between(0.35, 0.75);
        const drift = between(-0.08, 0.08);
        const pts: Pt[] = [];
        for (let i = 0; i < k; i++) {
          pts.push([cx + (cw * i) / (k - 1), cy + ch * (0.08 + 0.8 * v)]);
          v = Math.max(0, Math.min(1, v - drift + between(-0.14, 0.14)));
        }
        s +=
          gpath(smoothPath(pts), c) +
          gpath(`M${n1(cx)} ${n1(cy + ch)}h${n1(cw)}`, DIM, 'opacity=".6"');
        break;
      }
      case "bars": {
        const k = 4 + Math.floor(rnd() * 4);
        const hi = Math.floor(rnd() * k);
        const bwid = cw / k;
        for (let i = 0; i < k; i++) {
          const bh2 = ch * between(0.25, 1);
          s += box(
            cx + i * bwid + bwid * 0.18,
            cy + ch - bh2,
            bwid * 0.64,
            bh2,
            c,
            i === hi ? ".85" : ".4",
            1,
          );
        }
        break;
      }
      case "grid": {
        const gc = Math.max(2, Math.min(4, Math.round((cw / ch) * 2)));
        const gr = Math.max(1, Math.min(3, Math.round((gc * ch) / cw + 0.3)));
        const gg = m * 0.08;
        const tw = (cw - gg * (gc - 1)) / gc;
        const th = (ch - gg * (gr - 1)) / gr;
        const lit = Math.floor(rnd() * gc * gr);
        for (let i = 0; i < gc * gr; i++)
          s += box(
            cx + (i % gc) * (tw + gg),
            cy + Math.floor(i / gc) * (th + gg),
            tw,
            th,
            c,
            i === lit ? ".6" : ".22",
          );
        break;
      }
      case "bubbles": {
        const k = 2 + Math.floor(rnd() * 2);
        const bht = ch / (k * 1.4);
        for (let i = 0; i < k; i++) {
          const me = (i + (rnd() < 0.5 ? 1 : 0)) % 2 === 1;
          const bwd = cw * between(0.45, 0.7);
          s += box(
            me ? cx + cw - bwd : cx,
            cy + i * bht * 1.4,
            bwd,
            bht,
            me ? c : DIM,
            me ? ".6" : ".5",
            bht / 2,
          );
        }
        break;
      }
      case "keys": {
        const k = 5 + Math.floor(rnd() * 4);
        const kw = cw / k;
        for (let i = 0; i < k; i++)
          s += box(
            cx + i * kw,
            cy + ch * 0.45,
            kw - Math.max(1, kw * 0.15),
            ch * 0.55,
            c,
            ".3",
            1,
          );
        for (let i = 0; i < 3; i++)
          s += box(
            cx + Math.floor(rnd() * k) * kw,
            cy + ch * between(0, 0.25),
            kw * 0.8,
            ch * 0.13,
            c,
            ".8",
            1,
          );
        break;
      }
      case "image": {
        // a picture: rolling hills under a sun (low and wide, whatever the cell's shape: a hill is never a spike)
        const hb = cy + ch * 0.86;
        const hh = Math.min(ch * 0.32, cw * 0.18);
        const hp: Pt[] = [
          [cx + cw * 0.06, hb - hh * 0.2],
          [cx + cw * between(0.3, 0.38), hb - hh * between(0.85, 1)],
          [cx + cw * 0.6, hb - hh * 0.45],
          [cx + cw * between(0.76, 0.82), hb - hh * between(0.6, 0.75)],
          [cx + cw * 0.94, hb - hh * 0.3],
        ];
        s +=
          box(cx, cy, cw, ch, c, ".18", m * 0.12) +
          gpath(smoothPath(hp), c) +
          circ(
            n1(cx + cw * 0.22),
            n1(cy + ch * 0.26),
            n1(m * 0.09),
            "zb-dot",
            fill(c, ".7"),
          );
        break;
      }
      case "ring": {
        const rr = m * 0.38;
        const rx = cx + cw * (cw > ch * 1.6 ? 0.25 : 0.5);
        const ry = cy + ch / 2;
        s +=
          `<circle class="zb-l" stroke="${DIM}" opacity=".6" cx="${n1(rx)}" cy="${n1(ry)}" r="${n1(rr)}"/>` +
          `<circle class="zb-l" stroke="${c}" cx="${n1(rx)}" cy="${n1(ry)}" r="${n1(rr)}" pathLength="1" stroke-dasharray="${between(0.3, 0.85).toFixed(2)} 1" transform="rotate(-90 ${n1(rx)} ${n1(ry)})"/>`;
        if (cw > ch * 1.6)
          s += gpath(
            `M${n1(cx + cw * 0.55)} ${n1(ry - ch * 0.15)}h${n1(cw * 0.35)}M${n1(cx + cw * 0.55)} ${n1(ry + ch * 0.15)}h${n1(cw * 0.25)}`,
            DIM,
          );
        break;
      }
      case "list": {
        const k = 3 + Math.floor(rnd() * 2);
        for (let i = 0; i < k; i++) {
          const ly = cy + (ch * (i + 0.5)) / k;
          s += circ(
            n1(cx + m * 0.06),
            n1(ly),
            n1(Math.max(1.2, m * 0.05)),
            "zb-dot",
            fill(i === 0 ? c : DIM, "1"),
          );
          d += `M${n1(cx + m * 0.18)} ${n1(ly)}h${n1((cw - m * 0.18) * between(0.4, 0.95))}`;
        }
        s += gpath(d, c, 'opacity=".7"');
        break;
      }
      case "kpi":
        s +=
          box(cx, cy, cw * between(0.35, 0.55), ch * 0.42, c, ".6", 1) +
          gpath(
            `M${n1(cx)} ${n1(cy + ch * 0.7)}h${n1(cw * 0.8)}M${n1(cx)} ${n1(cy + ch * 0.92)}h${n1(cw * 0.5)}`,
            DIM,
          );
        break;
      case "cal": {
        // a month of days, a few marked
        const cc = Math.max(3, Math.min(7, Math.round((cw / ch) * 3)));
        const cr = 3;
        const dx = cw / cc;
        const dy = ch / cr;
        for (let i = 0; i < cc * cr; i++)
          s += circ(
            n1(cx + dx * ((i % cc) + 0.5)),
            n1(cy + dy * (Math.floor(i / cc) + 0.5)),
            n1(Math.max(1, Math.min(dx, dy) * 0.22)),
            "zb-dot",
            fill(rnd() < 0.2 ? c : DIM, rnd() < 0.2 ? "1" : ".6"),
          );
        break;
      }
    }
    return s;
  }
}
