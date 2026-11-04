import { clamp01, EASE, lerpRect, n1, smooth, type Rect } from "../kit/math";
import { OS_KINDS, osWindow, type OsKind } from "../kit/night";
import { OS_COL } from "../kit/palette";
import { setAttr, svgEl } from "../kit/svg";
import type { Timeline } from "../kit/timeline";
import { CA, IN, to3 } from "./geometry";
import { INTEGRATE_APPS, TYPED_CLASS } from "./integrate";

/**
 * 2 → 3: the window comes apart. `split()` takes chapter 2 as it is at that
 * instant: every app on screen (an app wholly under an opaque one is not)
 * becomes a piece — a copy of its drawing, moved to frame 3's units — and each
 * piece gets a place on the desktop that fits its shape. The places left over
 * get windows that split out of the app from beneath it. `pose(m)`, m 0 → 1:
 * every piece moves to its place and turns into its OS window.
 */

/** A place on the desktop a window settles into (frame 3 units), with where it sits on the orbit. */
export interface Place extends Rect {
  slot: number;
  cx: number;
  cy: number;
  /** Its perspective scale there. */
  f: number;
}

/** What the desktop sees of each window: its wrapper (free to move), its place, its kind and colour. */
export interface ApartWindow {
  fx: SVGGElement;
  place: Place;
  kind: OsKind;
  col: string;
}

interface Piece {
  src: Rect;
  to: Place;
  kind: OsKind;
  col: string;
  delay: number;
  g: SVGGElement;
  win: SVGGElement;
  fx: SVGGElement;
  copy?: SVGGElement;
  r0?: Rect;
}

export interface Apart {
  split(): void;
  pose(m: number): void;
  clear(): void;
  list(): ApartWindow[];
}

const inside = (a: Rect, b: Rect) =>
  a.x >= b.x - 1 &&
  a.y >= b.y - 1 &&
  a.x + a.w <= b.x + b.w + 1 &&
  a.y + a.h <= b.y + b.h + 1;

/** A copy of a drawn part: its ids (and the clip paths naming them) suffixed, so they stay unique. */
function copyOf(node: Element, suffix: string): Element {
  const c = node.cloneNode(true) as Element;
  for (const e of [c, ...c.querySelectorAll("*")]) {
    if (e.id) e.id += suffix;
    const cp = e.getAttribute("clip-path");
    if (cp) setAttr(e, "clip-path", cp.replace(/#([^)]+)\)/, `#$1${suffix})`));
    // the typed line's style is keyed by its part's id in the design: its copy is drawn as a plain link
    e.classList.remove(TYPED_CLASS);
  }
  return c;
}

export function mountApart(
  holder: SVGGElement,
  sc: Timeline,
  placesOf: () => Place[],
): Apart {
  let pieces: Piece[] = [];

  function onScreen() {
    const shown = INTEGRATE_APPS.map(({ part, kind }) => {
      const c = sc.paneState(part);
      return { part, kind, r: { x: c.x, y: c.y, w: c.w, h: c.h }, o: c.o };
    }).filter((a) => a.o > 0.3 && a.r.w > 40 && a.r.h > 40);
    return shown.filter(
      (a, i) => !shown.slice(i + 1).some((b) => b.o > 0.95 && inside(a.r, b.r)),
    );
  }

  const api: Apart = {
    split() {
      api.clear();
      const shown = onScreen();
      const taken = new Set<number>();
      const kinds = new Set<OsKind>();
      const PL = placesOf();
      if (PL.length < shown.length)
        throw new Error(
          `apart: ${PL.length} places for ${shown.length} apps on screen`,
        );
      const placed = new Map<string, { src: Rect; to: Place }>();
      // the biggest app first: the place whose shape and position fit it best
      [...shown]
        .sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h)
        .forEach((a) => {
          const src = to3(a.r);
          let best = -1;
          let bs = 1e9;
          PL.forEach((P, i) => {
            if (taken.has(i)) return;
            const s =
              Math.abs(Math.log(src.w / src.h / (P.w / P.h))) +
              0.002 *
                Math.hypot(
                  P.x + P.w / 2 - src.x - src.w / 2,
                  P.y + P.h / 2 - src.y - src.h / 2,
                );
            if (s < bs) {
              bs = s;
              best = i;
            }
          });
          taken.add(best);
          placed.set(a.part, { src, to: PL[best]! });
          kinds.add(a.kind);
        });
      // the rest of the desktop: windows splitting out of the app, from beneath what is on screen
      const CA3 = to3(CA);
      const from: Rect = {
        x: CA3.x + CA3.w * 0.15,
        y: CA3.y + CA3.h * 0.15,
        w: CA3.w * 0.7,
        h: CA3.h * 0.7,
      };
      const spare = OS_KINDS.filter((k) => !kinds.has(k));
      const extras: { src: Rect; to: Place; kind: OsKind }[] = [];
      PL.forEach((P, i) => {
        if (!taken.has(i))
          extras.push({ src: from, to: P, kind: spare.shift() ?? "doc" });
      });
      const all = [
        ...extras.map((a) => ({ ...a, part: null as string | null })),
        ...shown.map((a) => ({
          ...placed.get(a.part)!,
          kind: a.kind,
          part: a.part as string | null,
        })),
      ];
      all.forEach((a, j) => {
        const extra = a.part === null;
        const g = svgEl("g");
        const win = svgEl("g");
        g.appendChild(win);
        const pc: Piece = {
          src: a.src,
          to: a.to,
          kind: a.kind,
          col: OS_COL[j % OS_COL.length]!,
          delay: extra ? 0.12 + 0.05 * j : 0.04 * (j - extras.length),
          g,
          win,
          fx: svgEl("g"),
        };
        if (a.part !== null) {
          pc.copy = svgEl("g");
          pc.copy.appendChild(copyOf(sc.node(a.part), "-apart"));
          g.appendChild(pc.copy);
          const s = sc.paneState(a.part);
          pc.r0 = { x: s.x, y: s.y, w: s.w, h: s.h };
        }
        // fx: a wrapper the desktop may move freely (the pose owns pc.g)
        pc.fx.appendChild(g);
        holder.appendChild(pc.fx);
        pieces.push(pc);
      });
    },
    pose(m) {
      for (const pc of pieces) {
        const mj = EASE.io(
          clamp01((m - pc.delay) / (1 - Math.max(0, pc.delay))),
        );
        const r = lerpRect(pc.src, pc.to, mj);
        setAttr(pc.win, "transform", `translate(${n1(r.x)} ${n1(r.y)})`);
        pc.win.innerHTML = osWindow(pc.kind, r.w, r.h, pc.col);
        setAttr(
          pc.win,
          "opacity",
          (pc.copy ? smooth((mj - 0.05) / 0.4) : smooth(mj / 0.3)).toFixed(3),
        );
        if (pc.copy) {
          const k = r.w / pc.src.w / IN[2]!.r;
          setAttr(
            pc.copy,
            "transform",
            `translate(${n1(r.x)} ${n1(r.y)}) scale(${k.toFixed(4)}) translate(${n1(-pc.r0!.x)} ${n1(-pc.r0!.y)})`,
          );
          setAttr(pc.copy, "opacity", (1 - smooth(mj / 0.45)).toFixed(3));
        }
      }
    },
    clear() {
      for (const pc of pieces) holder.removeChild(pc.fx);
      pieces = [];
    },
    list() {
      return pieces.map((pc) => ({
        fx: pc.fx,
        place: pc.to,
        kind: pc.kind,
        col: pc.col,
      }));
    },
  };
  return api;
}
