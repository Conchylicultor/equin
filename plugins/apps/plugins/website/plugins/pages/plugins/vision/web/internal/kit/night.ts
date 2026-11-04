import { n1 } from "./math";
import { AC, C, HUE, type Kind } from "./palette";
import { circ, rect, text } from "./svg";

/**
 * The night-orbs vocabulary: what every frame of the zoom is drawn with — a
 * glowing line (a wide faint stroke under a thin one), windows, beads, chips,
 * icons, bubbles. Markup strings, read through the classes in
 * `components/vision-ladder.css`; every colour is a palette reference.
 */

/** A primitive's glyph inside an s×s square at (x, y). */
export function glyph(k: Kind, x: number, y: number, s: number): string {
  const P = (a: number, b: number) => `${n1(x + s * a)} ${n1(y + s * b)}`;
  let d = "";
  if (k === "list") {
    for (let i = 0; i < 3; i++) {
      const yy = 0.2 + 0.3 * i;
      d += `M${P(0.12, yy)}h.01M${P(0.28, yy)}L${P(0.9, yy)}`;
    }
  } else if (k === "diff") {
    for (let i = 0; i < 3; i++) {
      const y2 = 0.2 + 0.3 * i;
      d += `M${P(0.08, y2)}L${P(0.42, y2)}M${P(0.58, y2)}L${P(i === 1 ? 0.8 : 0.92, y2)}`;
    }
  } else if (k === "keys") {
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 3; c++)
        d += `M${P(0.1 + c * 0.3, 0.2 + r * 0.35)}h${n1(s * 0.22)}v${n1(s * 0.24)}h${n1(-s * 0.22)}z`;
  } else {
    return (
      `<g><rect class="zk zk-chip" x="${n1(x + s * 0.06)}" y="${n1(y + s * 0.3)}" width="${n1(s * 0.88)}" height="${n1(s * 0.4)}" rx="${n1(s * 0.2)}"/>` +
      `<path class="zk zk-chip" d="M${P(0.26, 0.5)}h.01M${P(0.42, 0.5)}L${P(0.78, 0.5)}"/></g>`
    );
  }
  return `<path class="zk zk-${k}" d="${d}"/>`;
}

/**
 * A glowing path: the wide faint glow and the thin line over it. `ex` may carry
 * a `class="…"`, added to both.
 */
export function gpath(d: string, col: string, ex = ""): string {
  const m = /class="([^"]*)"/.exec(ex);
  const cl = m ? ` ${m[1]}` : "";
  const rest = ex.replace(/class="[^"]*"/, "");
  return `<path class="zb-g${cl}" stroke="${col}" d="${d}" ${rest}/><path class="zb-l${cl}" stroke="${col}" d="${d}" ${rest}/>`;
}

/** A glowing rectangle, faintly filled with its colour. */
export function grect(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  col: string,
): string {
  return (
    `<rect class="zb-g" stroke="${col}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>` +
    `<rect class="zb-l zb-f" stroke="${col}" fill="${col}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`
  );
}

/** A window: solid (unless `airy`), a glowing outline, a title bar with two dots and a name. */
export function winB(
  x: number,
  y: number,
  w: number,
  h: number,
  col: string,
  title: string,
  bar = 30,
  airy = false,
): string {
  return (
    (airy ? "" : rect(x, y, w, h, "zb-pop", 14)) +
    grect(x, y, w, h, 14, col) +
    `<path class="zb-l" stroke="${col}" opacity=".6" d="M${x} ${y + bar}h${w}"/>` +
    circ(x + 16, y + bar / 2, 3.5, "zb-dot", `fill="${col}"`) +
    circ(x + 30, y + bar / 2, 3.5, "zb-dot", `fill="${col}"`) +
    (title
      ? text(
          x + 46,
          y + bar / 2 + 5,
          title,
          "z-sub",
          "start",
          15,
          `style="fill:${col}"`,
        )
      : "")
  );
}

/** A star: a soft halo and a white core. */
export function star(x: number, y: number, r: number, col: string): string {
  return (
    circ(x, y, r * 3, "zb-halo", `fill="${col}"`) +
    circ(x, y, r, "zb-dot", `fill="${C.white}"`)
  );
}

/** A bead: a primitive of kind k, as a ringed dot carrying its glyph. */
export function bead(k: Kind, x: number, y: number, r: number): string {
  return (
    circ(x, y, r, "zb-bead", `stroke="${HUE[k]}"`) +
    glyph(k, n1(x - r * 0.62), n1(y - r * 0.62), n1(r * 1.24))
  );
}

const LINE_WIDTHS = [1, 0.7, 0.85, 0.5, 0.75];
/** n lines of text, each a stroke of its own length. */
export function lines(
  x: number,
  y: number,
  w: number,
  n: number,
  col: string = C.dim,
  gap = 24,
): string {
  let d = "";
  for (let i = 0; i < n; i++)
    d += `M${x} ${y + i * gap}h${n1(w * LINE_WIDTHS[i % 5]!)}`;
  return gpath(d, col, 'opacity=".7"');
}

export const CURSOR =
  '<path class="zb-cursor" d="M0 0L0 23L6.5 17L11 27L15.5 25L11 15.5L19.5 15.5Z"/>';

/** A frame's disc: its radial ground, anything drawn on it, and its rim. `id` names the gradient. */
export function disc(id: string, extra = ""): string {
  return (
    `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${C.discCore}"/><stop offset=".6" stop-color="${C.discMid}"/><stop offset="1" stop-color="${C.discEdge}"/></radialGradient></defs>` +
    circ(0, 0, 500, "zb-box", `fill="url(#${id})"`) +
    extra +
    circ(0, 0, 500, "zb-rim")
  );
}

/** The spark: the idea, and the app's improve button. */
export const sparkB = (): string =>
  circ(0, 0, 18, "zb-halo", `fill="${C.azure}"`) + star(0, 0, 3.4, C.azure);

/** A wish too small to read. */
export const wishPill = (w: number): string =>
  rect(-w / 2, -w / 5.6, w, w / 2.8, "zb-note zb-wnote", w / 5.6);

export type IconKind = "pin" | "chat" | "proto" | "file" | "page" | "note";

/** A small icon of an app, centred on (x, y). */
export function icon(
  kind: IconKind,
  x: number,
  y: number,
  col: string,
): string {
  const s = `stroke="${col}"`;
  switch (kind) {
    case "pin":
      return (
        `<path class="zb-l" ${s} d="M${x} ${y + 7}c-4 -5 -6 -7 -6 -10a6 6 0 0 1 12 0c0 3 -2 5 -6 10z"/>` +
        circ(x, y - 3, 1.8, "zb-dot", `fill="${col}"`)
      );
    case "chat":
      return `<path class="zb-l" ${s} d="M${x - 7} ${y - 5}h14v9h-8l-4 4v-4h-2z"/>`;
    case "proto":
      return `<rect class="zb-l" ${s} x="${x - 4.5}" y="${y - 7}" width="9" height="14" rx="2"/>`;
    case "file":
      return `<path class="zb-l" ${s} d="M${x - 5} ${y - 7}h6l4 4v10h-10z"/>`;
    case "page":
      return `<path class="zb-l" ${s} d="M${x - 5} ${y - 7}h10v14h-10zM${x - 2.5} ${y - 3}h5M${x - 2.5} ${y}h5M${x - 2.5} ${y + 3}h3"/>`;
    case "note":
      return (
        `<path class="zb-l" ${s} d="M${x + 2} ${y + 4}v-11l5 2"/>` +
        circ(x - 0.5, y + 4.5, 2.6, "zb-dot", `fill="${col}"`)
      );
  }
}

/** A link to another app, inline: its icon and a short stroke, in that app's colour; centred on (0, 0). */
export function chipA(kind: IconKind, col: string): string {
  return (
    rect(-30, -11, 60, 22, "zb-chip", 11, `style="stroke:${col};fill:${col}"`) +
    icon(kind, -15, 0, col) +
    gpath("M-4 0h20", col, 'opacity=".8"')
  );
}

export const expandIcon = (x: number, y: number, col: string): string =>
  `<path class="zb-l" stroke="${col}" d="M${x - 6} ${y - 1}v-5h5M${x + 6} ${y + 1}v5h-5"/>`;

/** A folder: the prototype's files, a click away. */
export const folderIcon = (x: number, y: number, col: string): string =>
  `<path class="zb-l" stroke="${col}" d="M${x - 7} ${y - 5}h5l2 2h7v9h-14z"/>`;

/** A chat bubble: yours (`me`, in the app's colour) or theirs. */
export function bubble(
  x: number,
  y: number,
  w: number,
  me: boolean,
  col: string = AC.chat,
): string {
  const c = me ? col : C.dim;
  return (
    rect(x, y, w, 26, "zb-bubble", 10, `style="stroke:${c};fill:${c}"`) +
    gpath(
      `M${x + 12} ${y + 13}h${n1(Math.max(4, w - 30))}`,
      me ? col : C.haze,
      'opacity=".6"',
    )
  );
}

export type OsKind = "doc" | "chat" | "grid" | "list" | "chart" | "keys";
export const OS_KINDS: readonly OsKind[] = [
  "doc",
  "chat",
  "grid",
  "list",
  "chart",
  "keys",
];

/**
 * The OS's own abstract picture of an app of `kind`, laid out for its size
 * (w × h) from its top-left, so a window can be redrawn at every size it passes
 * through while it moves to its place.
 */
export function osWindow(
  kind: OsKind,
  w0: number,
  h0: number,
  col: string,
): string {
  const w = Math.max(24, w0);
  const h = Math.max(24, h0);
  let o =
    rect(0, 0, w, h, "zb-pop", 10) +
    grect(0, 0, w, h, 10, col) +
    `<path class="zb-l" stroke="${col}" opacity=".5" d="M0 20h${w}"/>` +
    circ(11, 10, 2.8, "zb-dot", `fill="${col}"`) +
    circ(21, 10, 2.8, "zb-dot", `fill="${col}"`);
  const x = 14;
  const y = 36;
  const iw = w - 28;
  const ih = h - 50;
  let d = "";
  if (iw < 30 || ih < 24) return o;
  switch (kind) {
    case "doc": {
      o += gpath(`M${x} ${y}h${n1(iw * 0.55)}`, col, 'class="zb-thick"');
      const n = Math.floor((ih - 12) / 18);
      for (let i = 0; i < n; i++)
        d += `M${x} ${y + 26 + i * 18}h${n1(iw * [1, 0.8, 0.92, 0.6, 0.85][i % 5]!)}`;
      o += gpath(d, C.dim, 'opacity=".7"');
      break;
    }
    case "chat": {
      const n = Math.floor((ih + 6) / 32);
      for (let i = 0; i < n; i++) {
        const me = i % 2 === 1;
        const bw = n1(iw * (me ? 0.55 : 0.72));
        o += bubble(me ? n1(x + iw - bw) : x, y - 6 + i * 32, bw, me, col);
      }
      break;
    }
    case "grid": {
      const cols = Math.max(1, Math.floor((iw + 10) / 54));
      const rows = Math.max(1, Math.floor((ih + 10) / 58));
      const tw = (iw - (cols - 1) * 10) / cols;
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++)
          o += rect(
            n1(x + j * (tw + 10)),
            y - 4 + i * 58,
            n1(tw),
            48,
            "zb-mini",
            7,
            `style="stroke:${(i * cols + j) % 4 === 1 ? col : C.deep}"`,
          );
      break;
    }
    case "list": {
      const n = Math.floor((ih + 8) / 22);
      for (let i = 0; i < n; i++) {
        const yy = y + i * 22;
        const on = i === 1;
        o +=
          circ(x + 4, yy, 3, "zb-dot", `fill="${on ? col : C.dim}"`) +
          gpath(
            `M${x + 16} ${yy}h${n1((iw - 16) * [0.8, 0.55, 0.7, 0.45, 0.65][i % 5]!)}`,
            on ? col : C.dim,
            'opacity=".75"',
          );
      }
      break;
    }
    case "chart": {
      const ys = [0.75, 0.5, 0.6, 0.3, 0.45, 0.15, 0.3];
      for (let i = 0; i < 7; i++)
        d += `${i ? "L" : "M"}${n1(x + (iw * i) / 6)} ${n1(y + ih * 0.8 * ys[i]!)}`;
      o +=
        gpath(d, col) +
        gpath(`M${x} ${n1(y + ih * 0.86)}h${iw}`, C.dim, 'opacity=".6"');
      break;
    }
    case "keys": {
      const ky = n1(y + ih * 0.5);
      const nk = Math.max(3, Math.floor(iw / 22));
      const kw = iw / nk;
      for (let i = 0; i < nk; i++)
        o += rect(n1(x + i * kw), ky, n1(kw - 3), n1(ih * 0.5), "zb-key", 3);
      for (let i = 0; i < 4; i++)
        o += rect(
          n1(x + ((i * 3 + 1) % nk) * kw + 3),
          n1(y + i * ih * 0.09),
          n1(Math.max(2, kw - 9)),
          n1(ih * 0.16),
          "zb-note2",
          3,
        );
      break;
    }
  }
  return o;
}
