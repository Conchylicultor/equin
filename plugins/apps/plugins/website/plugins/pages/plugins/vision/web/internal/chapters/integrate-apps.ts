import { n1 } from "../kit/math";
import {
  bubble,
  chipA,
  expandIcon,
  folderIcon,
  gpath,
  icon,
  lines,
  type IconKind,
} from "../kit/night";
import { AC, C } from "../kit/palette";
import { circ, g, rect } from "../kit/svg";

/**
 * Chapter 2's apps, abstract: no names, each one told by its picture. Every
 * body is drawn from its own top-left. A host app keeps a side column (SL, in
 * the host's units) where a guest app opens: the guest is a pane INSIDE the
 * host, in place of what that column showed, and the host does not move.
 */

/** A host's side column, where a guest opens (the window is 592 × 381). */
export const SL = { x: 382, y: 8, w: 202, h: 365 };
/**
 * The page: a heading, a paragraph, a typed line ending in a place link; the
 * place, once it unfurls, pushes the rest of the page (below) down by PUSH.
 */
export const PAGE = {
  w: 592,
  h: 381,
  link: [136, 130, 210] as const,
  map: { x: 136, y: 150, w: 424, h: 160 },
  chat: [180, 188] as const,
};
export const PUSH = 172;

/** The page's side: its list of pages. Previewed in a side column, the page shows its text without it. */
export function pageSide(): string {
  let o = "";
  const W = [60, 44, 70, 52, 40, 64, 48, 58, 36];
  for (let i = 0; i < 9; i++)
    o +=
      circ(
        22,
        26 + i * 28,
        3,
        "zb-dot",
        `fill="${i === 2 ? AC.page : C.dim}"`,
      ) +
      gpath(
        `M34 ${26 + i * 28}h${W[i]!}`,
        i === 2 ? AC.page : C.dim,
        'opacity=".7"',
      );
  return (
    o +
    rect(10, 70, 100, 24, "zb-sel", 6) +
    `<path class="zb-l" stroke="${C.dim}" opacity=".5" d="M120 12V${PAGE.h - 12}"/>`
  );
}
export const pageMain = (): string =>
  gpath("M136 34h210", C.pale, 'class="zb-thick"') +
  lines(136, 64, 400, 3, C.dim, 20);
export const pageTop = (): string => pageSide() + pageMain();
export const linkLine = (): string => {
  const L = PAGE.link;
  return `M${L[0]} ${L[1]}h${L[2]}`;
};
export const linkChip = (): string => {
  const L = PAGE.link;
  return g(chipA("pin", AC.map), `translate(${L[0] + L[2] + 40} ${L[1]})`);
};
export function pageBelow(): string {
  return (
    lines(136, 158, 380, 1, C.dim) +
    gpath("M222 188h200", C.dim, 'opacity=".7"') +
    g(chipA("chat", AC.chat), `translate(${PAGE.chat[0]} ${PAGE.chat[1]})`)
  );
}

/** The place, unfurled in the page: streets, a river, a park, pins. */
export function mapBody(w: number, h: number): string {
  return (
    rect(0, 0, w, h, "zb-mapbg", 10) +
    gpath(
      `M0 ${n1(h * 0.62)}C${n1(w * 0.3)} ${n1(h * 0.45)} ${n1(w * 0.55)} ${n1(h * 0.9)} ${w} ${n1(h * 0.7)}`,
      C.cyan,
      'opacity=".5" class="zb-thick"',
    ) +
    gpath(
      `M${n1(w * 0.18)} 0L${n1(w * 0.32)} ${h}M0 ${n1(h * 0.28)}H${w}M${n1(w * 0.7)} 0L${n1(w * 0.62)} ${h}`,
      C.dim,
      'opacity=".8"',
    ) +
    rect(n1(w * 0.4), n1(h * 0.12), n1(w * 0.16), n1(h * 0.26), "zb-park", 6) +
    `<g class="zb-pinbob">${g(icon("pin", 0, 0, AC.map), `translate(${n1(w * 0.48)} ${n1(h * 0.52)}) scale(2.2)`)}</g>` +
    g(
      icon("pin", 0, 0, AC.file),
      `translate(${n1(w * 0.78)} ${n1(h * 0.34)}) scale(1.6)`,
    ) +
    g(
      icon("pin", 0, 0, AC.chat),
      `translate(${n1(w * 0.24)} ${n1(h * 0.78)}) scale(1.6)`,
    )
  );
}

/**
 * The conversation: ONE drawing, which floats as the helper and then is the
 * agent manager's conversation — expanding the helper grows that same surface,
 * its list of conversations coming in beside it. A few turns back and forth;
 * the agent's later replies bring a prototype.
 */
export const CW = 210;
export const CH = 354;
export const CONV = {
  chat: [5, 38],
  agent: [168, 18],
  proto: [38, 194],
} as const;

/** An agent's message carrying something it made: a bubble holding that thing's link. */
function attach(y: number, kind: IconKind, col: string): string {
  return (
    rect(
      4,
      y,
      150,
      36,
      "zb-bubble",
      12,
      `style="stroke:${C.dim};fill:${C.dim}"`,
    ) +
    g(chipA(kind, col), `translate(38 ${y + 18})`) +
    gpath(`M78 ${y + 18}h60`, C.haze, 'opacity=".6"')
  );
}
/** Turns alternate: you, the agent, you, the agent — then (once expanded) you ask, and it answers with a prototype. */
export function convBody(ask: string, reply: string): string {
  return (
    bubble(86, 6, 110, true, AC.chat) +
    bubble(4, 40, 150, false) +
    bubble(106, 74, 90, true, AC.chat) +
    bubble(4, 108, 164, false) +
    ask +
    reply +
    rect(4, 286, 196, 24, "zb-pill zb-dim", 12)
  );
}
export const convAsk = (): string => bubble(96, 142, 100, true, AC.chat);
export const convReply = (): string => attach(176, "proto", AC.proto);
export function chatHead(): string {
  return (
    `<path class="zb-l" stroke="${AC.chat}" opacity=".5" d="M0 32h${CW}"/>` +
    circ(16, 16, 3.5, "zb-dot", `fill="${AC.chat}"`) +
    expandIcon(CW - 18, 16, AC.chat)
  );
}
/** The agent manager's list of conversations. */
export function agentList(h: number): string {
  let o = "";
  const A = [70, 56, 80, 62, 50, 74, 58];
  const B = [90, 84, 70, 92, 66, 80, 88];
  for (let i = 0; i < 7; i++) {
    const y = 30 + i * 46;
    o +=
      circ(26, y, 9, "zb-l", `stroke="${i === 1 ? AC.chat : C.dim}"`) +
      gpath(
        `M44 ${y - 5}h${A[i]!}`,
        i === 1 ? C.pale : C.haze,
        'opacity=".75"',
      ) +
      gpath(`M44 ${y + 6}h${B[i]!}`, C.dim, 'opacity=".6"');
  }
  return (
    o +
    rect(8, 56, 136, 40, "zb-sel", 8) +
    `<path class="zb-l" stroke="${C.dim}" opacity=".5" d="M152 12V${h - 12}"/>`
  );
}

/** The prototype: a phone-sized mock, its files a folder click away. */
export function protoBody(): string {
  const w = SL.w;
  const cx = w / 2;
  const px = cx - 62;
  return (
    gpath("M16 18h40", AC.proto, 'opacity=".7"') +
    folderIcon(w - 20, 18, AC.proto) +
    rect(px, 40, 124, 250, "zb-mini", 18, `style="stroke:${AC.proto}"`) +
    rect(cx - 16, 48, 32, 6, "zb-dot", 3, `fill="${AC.proto}" opacity=".5"`) +
    rect(px + 12, 70, 100, 70, "zb-mini", 8, `style="stroke:${C.dim}"`) +
    gpath(
      `M${px + 12} 140L${px + 50} 100L${px + 74} 124L${px + 90} 110L${px + 112} 140`,
      C.dim,
    ) +
    lines(px + 14, 162, 92, 3, C.dim, 18) +
    rect(
      px + 12,
      230,
      100,
      24,
      "zb-chip",
      12,
      `style="stroke:${AC.proto};fill:${AC.proto}"`,
    ) +
    rect(px + 30, 264, 64, 12, "zb-pill zb-dim", 6)
  );
}

/** A video's preview: the picture, its play button and timeline, a few lines about it. */
export function videoBody(): string {
  const w = SL.w;
  return (
    gpath("M16 18h56", AC.video, 'opacity=".7"') +
    rect(12, 40, w - 24, 112, "zb-mapbg", 8) +
    gpath(`M12 128L60 92L96 116L130 84L${w - 12} 124`, C.dim, 'opacity=".8"') +
    circ(w / 2, 96, 18, "zb-bead", `stroke="${AC.video}"`) +
    `<path class="zb-l" stroke="${AC.video}" d="M${w / 2 - 5} 88l13 8l-13 8z"/>` +
    `<path class="zb-l" stroke="${C.dim}" d="M12 172h${w - 24}"/>` +
    gpath("M12 172h70", AC.video) +
    circ(82, 172, 4, "zb-dot", `fill="${AC.video}"`) +
    lines(12, 204, w - 40, 4, C.dim, 22)
  );
}

/** The explorer: folders | files; the file a click opens shows in its side column. */
export const TILES = ["proto", "video", "file", "note", "page", "pin"] as const;
export type Tile = (typeof TILES)[number];
export const tileAt = (j: number): [number, number] => [
  166 + (j % 3) * 68,
  30 + Math.floor(j / 3) * 84,
];
const TILE_COL: Record<Tile, string> = {
  proto: AC.proto,
  video: AC.video,
  file: C.haze,
  note: AC.sonata,
  page: AC.page,
  pin: AC.map,
};
export function explorerBody(h: number): string {
  let o = "";
  const IND = [0, 1, 1, 2, 2, 1, 0, 0];
  const W = [60, 50, 64, 40, 56, 44, 70, 50];
  for (let i = 0; i < 8; i++) {
    const ind = IND[i]!;
    const on = i === 2;
    o +=
      folderIcon(23 + ind * 14, 30 + i * 30, on ? AC.file : C.dim) +
      gpath(
        `M${38 + ind * 14} ${30 + i * 30}h${W[i]!}`,
        on ? AC.file : C.dim,
        'opacity=".7"',
      );
  }
  o +=
    rect(8, 82, 136, 26, "zb-sel", 6) +
    `<path class="zb-l" stroke="${C.dim}" opacity=".5" d="M152 12V${h - 12}M376 12V${h - 12}"/>`;
  TILES.forEach((k, j) => {
    const p = tileAt(j);
    const col = TILE_COL[k];
    o +=
      rect(p[0], p[1], 60, 72, "zb-mini", 9, `style="stroke:${C.deep}"`) +
      g(
        k === "video"
          ? `<rect class="zb-l" stroke="${col}" x="-7" y="-5" width="14" height="10" rx="2"/><path class="zb-l" stroke="${col}" d="M-2 -2.5l5 2.5l-5 2.5z"/>`
          : icon(k, 0, 0, col),
        `translate(${p[0] + 30} ${p[1] + 30}) scale(2)`,
      ) +
      gpath(`M${p[0] + 14} ${p[1] + 58}h32`, C.dim, 'opacity=".6"');
  });
  return o;
}

/** The piano roll: a song's notes falling onto the keys. `id` names its clip path. */
export function sonataBody(id: string): string {
  const w = SL.w;
  const h = SL.h;
  const ky = h - 100;
  const kw = (w - 24) / 7;
  let o = `<clipPath id="${id}"><rect x="12" y="40" width="${w - 24}" height="${ky - 44}"/></clipPath><g clip-path="url(#${id})">`;
  const NOTES = [
    [0, 0],
    [2, 1.1],
    [4, 0.5],
    [1, 2.0],
    [5, 1.6],
    [3, 2.7],
    [6, 0.9],
    [2, 3.2],
  ] as const;
  NOTES.forEach((nn, j) => {
    o += `<g class="zb-fall" style="animation-delay:${n1(-nn[1])}s">${rect(n1(12 + nn[0] * kw + 4), 0, n1(kw - 8), 30 + (j % 3) * 14, "zb-note2", 4)}</g>`;
  });
  o += `</g><path class="zb-l" stroke="${AC.sonata}" opacity=".6" d="M12 ${ky}h${w - 24}"/>`;
  for (let i = 0; i < 7; i++)
    o += rect(n1(12 + i * kw), ky + 4, n1(kw - 2), 82, "zb-key", 4);
  for (const k of [0, 1, 3, 4, 5])
    o += rect(
      n1(12 + (k + 1) * kw - kw * 0.3),
      ky + 4,
      n1(kw * 0.6),
      48,
      "zb-bkey",
      3,
    );
  return o + gpath("M16 18h40", AC.sonata, 'opacity=".7"');
}
