import { EASE, n1, smooth, type Pt } from "../kit/math";
import { disc, gpath, star } from "../kit/night";
import { C } from "../kit/palette";
import { all, circ, one, rect, setAttr, text } from "../kit/svg";
import type { Frame } from "./frame";

/**
 * Chapter 0 — an idea: a spark breathing; wishes come out of it, one after
 * another, only while the chapter is read.
 */

const WISH_SLOTS = 5;
const WISH_SECONDS = 10;
const WISHES = [
  "I wish my notes linked to my tasks",
  "I wish Maps had a bakery list",
  "I wish my budget was one tap away",
  "I wish there was an app for chords",
  "I wish my inbox grouped by project",
  "I wish the docs opened beside the code",
  "I wish there was an app for my garden",
  "I wish I could practice piano with my songs",
  "I wish the calendar showed my focus time",
];
/**
 * Places all around the spark (frame units), each a bubble's centre: to its
 * sides as much as above and below it. A bubble never takes one in use.
 */
const WISH_SPOTS: readonly Pt[] = [
  [-285, -15],
  [290, 10],
  [-300, 95],
  [300, -95],
  [-230, -170],
  [225, -185],
  [-220, 180],
  [240, 165],
  [-40, -290],
  [30, 290],
];
/** A bubble, and where it drifts to, stays inside this circle (the frame's disc is 500). */
const WISH_R = 470;

export function ideaFrame(prefix: string): Frame {
  let b = '<g class="zb-wishes">';
  for (let i = 0; i < WISH_SLOTS; i++)
    b += `<g data-wish-slot opacity="0">${rect(-100, -26, 200, 52, "zb-note zb-wnote", 26)}${text(0, 7, "", "zb-pilltxt", "middle", 19)}</g>`;
  b += "</g>";
  b +=
    `<g class="zb-pulse">${circ(0, 0, 120, "zb-halo", `fill="${C.azure}"`)}</g>` +
    '<circle class="zb-pulsering" cx="0" cy="0" r="70" opacity="0"/><circle class="zb-pulsering" cx="0" cy="0" r="70" opacity="0"/>';
  for (let i = 0; i < 10; i++) {
    const a = (i * 36 * Math.PI) / 180;
    const l = 40 + (i % 2) * 54;
    b += gpath(
      `M${n1(Math.cos(a) * 16)} ${n1(Math.sin(a) * 16)}L${n1(Math.cos(a) * l)} ${n1(Math.sin(a) * l)}`,
      C.ray,
      `class="zb-twinkle" style="animation-delay:${n1(-i * 0.37)}s"`,
    );
  }
  b += star(0, 0, 14, C.azure);
  return { back: disc(`${prefix}g0`), front: b };
}

interface Slot {
  el: SVGGElement;
  txt: SVGTextElement;
  box: SVGRectElement;
  i: number;
  cycle: number;
  w: number;
  c: Pt | null;
  spot: number | null;
}

export interface Wishes {
  /** The idea's chapter is being read. Turning on starts the stream fresh from the spark. */
  setOn(v: boolean): void;
  tick(dt: number): void;
}

/** Frame 0's wishes and pulse, on their own clock. `front` is frame 0's mounted drawing. */
export function mountWishes(front: Element): Wishes {
  let next = Math.floor(Math.random() * WISHES.length);
  const used = new Set<number>();
  let t = 0;
  let on = false;
  let alpha = 0;
  let clock = 0;
  const group = one<SVGGElement>(front, ".zb-wishes");
  const pulse = one<SVGGElement>(front, ".zb-pulse");
  const rings = all<SVGCircleElement>(front, ".zb-pulsering");
  const slots: Slot[] = all<SVGGElement>(front, "[data-wish-slot]").map(
    (el, i) => ({
      el,
      txt: one<SVGTextElement>(el, "text"),
      box: one<SVGRectElement>(el, "rect"),
      i,
      cycle: -1,
      w: 200,
      c: [0, 0],
      spot: null,
    }),
  );

  function place(s: Slot) {
    if (s.spot != null) used.delete(s.spot);
    s.c = null;
    s.txt.textContent = WISHES[next++ % WISHES.length]!;
    const w = s.txt.getComputedTextLength() + 44;
    // keep the bubble — and where it drifts to (its centre × 1.18) — inside the frame's circle
    const at = (k: number): Pt => {
      const sp = WISH_SPOTS[k]!;
      const lim =
        Math.sqrt(
          Math.max(
            0,
            WISH_R * WISH_R - Math.pow(Math.abs(sp[1]) * 1.18 + 26, 2),
          ),
        ) / 1.18;
      return [Math.max(-lim + w / 2, Math.min(lim - w / 2, sp[0])), sp[1]];
    };
    const clear = (k: number) => {
      const p = at(k);
      return slots.every(
        (o) =>
          !o.c ||
          Math.abs(o.c[1] - p[1]) > 64 ||
          Math.abs(o.c[0] - p[0]) > (o.w + w) / 2 + 16,
      );
    };
    const free = WISH_SPOTS.map((_, k) => k)
      .filter((k) => !used.has(k))
      .sort(() => Math.random() - 0.5);
    const si = free.filter(clear)[0] ?? free[0]!;
    used.add(si);
    s.spot = si;
    s.w = w;
    s.c = at(si);
    setAttr(s.box, "x", String(n1(-w / 2)));
    setAttr(s.box, "width", String(n1(w)));
  }

  // one bubble's life, f in 0…1: out of the spark to its place, a slow drift outward, then away as it fades
  function pose(s: Slot, f: number) {
    const C0 = s.c!;
    let k: number;
    let sc: number;
    let o: number;
    if (f < 0.16) {
      const e = EASE.out(f / 0.16);
      k = e;
      sc = 0.12 + 0.88 * e;
      o = e;
    } else if (f < 0.74) {
      k = 1 + (0.08 * (f - 0.16)) / 0.58;
      sc = 1;
      o = 1;
    } else {
      const e2 = (f - 0.74) / 0.26;
      k = 1.08 + 0.1 * e2;
      sc = 1 - 0.04 * e2;
      o = 1 - e2 * e2;
    }
    setAttr(
      s.el,
      "transform",
      `translate(${n1(C0[0] * k)} ${n1(C0[1] * k)}) scale(${sc.toFixed(3)})`,
    );
    setAttr(s.el, "opacity", o.toFixed(3));
  }

  return {
    setOn(v) {
      if (v && !on && alpha < 0.02) {
        t = 0;
        for (const s of slots) {
          s.cycle = -1;
          setAttr(s.el, "opacity", "0");
        }
      }
      on = v;
    },
    tick(dt) {
      clock += dt;
      // the spark's pulse: a soft swell, a slower ebb — each beat sending a faint ring outwards
      const BEAT = 3.6;
      const ph = (clock % BEAT) / BEAT;
      const env = ph < 0.22 ? smooth(ph / 0.22) : Math.exp(-(ph - 0.22) * 4);
      setAttr(pulse, "transform", `scale(${(0.9 + 0.2 * env).toFixed(4)})`);
      pulse.style.opacity = (0.5 + 0.5 * env).toFixed(3);
      rings.forEach((rg, i) => {
        const a =
          ((((clock - i * BEAT - 0.12 * BEAT) % (2 * BEAT)) + 2 * BEAT) %
            (2 * BEAT)) /
          (BEAT * 1.6);
        setAttr(
          rg,
          "transform",
          `scale(${(0.85 + 2 * EASE.out(Math.min(1, a))).toFixed(4)})`,
        );
        setAttr(
          rg,
          "opacity",
          a < 1
            ? (0.32 * smooth(a / 0.15) * (1 - a) * (1 - a)).toFixed(3)
            : "0",
        );
      });
      alpha += ((on ? 1 : 0) - alpha) * Math.min(1, dt / 0.35);
      group.style.opacity = alpha.toFixed(3);
      if (alpha < 0.005 && !on) return;
      t += dt;
      for (const s of slots) {
        const local = t - (s.i * WISH_SECONDS) / WISH_SLOTS;
        if (local < 0) continue;
        const cyc = Math.floor(local / WISH_SECONDS);
        if (cyc !== s.cycle) {
          s.cycle = cyc;
          place(s);
        }
        pose(s, (local % WISH_SECONDS) / WISH_SECONDS);
      }
    },
  };
}
