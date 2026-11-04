import type { Pt } from "../kit/math";
import { bead, disc, gpath, lines, sparkB, winB, wishPill } from "../kit/night";
import { C } from "../kit/palette";
import { circ } from "../kit/svg";
import { Timeline } from "../kit/timeline";
import type { Frame } from "./frame";
import { MAIN, SIDE, SPARK } from "./geometry";

/**
 * Chapter 1 — ideas change the app as you use it: now and then the spark (the
 * app's improve button) pulses, one idea leaves it and flies into the app, and
 * where it lands the app changes. One idea at a time; after six the app is
 * back to its plain layout — the window chapter 2's apps play in.
 */

const sideBody = () => lines(18, 32, 110, 9, C.dim, 30);
const mainBody = () =>
  lines(24, 34, 300, 5, C.dim, 34) +
  bead("list", 52, 236, 24) +
  bead("chip", 116, 236, 24) +
  bead("diff", 180, 236, 24);
/** See-through: the idea shows through it as it forms. */
const appWindow = () => winB(-390, -270, 780, 540, C.sky, "", 30, true);

export function appFrame(prefix: string): Frame {
  const sc = new Timeline(`${prefix}z1`, 15);
  let b = appWindow();
  b += sc.pane("side", C.ice, sideBody(), { ...SIDE, o: 1 });
  b += sc.pane("main", C.sky, mainBody(), { ...MAIN, o: 1 });
  b += sc.pane(
    "right",
    C.cyan,
    gpath("M20 220L60 170L100 190L140 120L180 140L220 80", C.cyan) +
      lines(20, 280, 180, 4, C.dim, 26),
    { x: 370, y: -226, w: 0, h: 476, o: 0 },
  );
  b += sc.pane(
    "bottom",
    C.teal,
    gpath("M20 100q20 -44 40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0", C.teal),
    {
      x: -210,
      y: 250,
      w: 330,
      h: 0,
      o: 0,
    },
  );
  b += sc.pane(
    "tool",
    C.aqua,
    bead("keys", 35, 50, 24) + bead("diff", 35, 120, 24),
    {
      x: -370,
      y: 250,
      w: 70,
      h: 0,
      o: 0,
    },
  );
  b += sc.item("rs", circ(0, 0, 12, "zb-ripple"), {
    x: SPARK[0],
    y: SPARK[1],
    s: 0.5,
    o: 0,
  });
  b += sc.item("rt", circ(0, 0, 14, "zb-ripple"), { x: 0, y: 0, s: 0.5, o: 0 });
  b += sc.item("w", wishPill(44), { x: SPARK[0], y: SPARK[1], s: 0.3, o: 0 });
  b += sc.item("spark", sparkB(), { x: SPARK[0], y: SPARK[1], s: 1, o: 1 });

  // one idea: the spark pulses, the wish leaves it and flies to `to`; the change starts as it lands (returned)
  const idea = (t: number, to: Pt) => {
    const land = t + 0.85;
    sc.at(t, "spark", { s: 1.8 }, 0.25, "out")
      .at(t + 0.25, "spark", { s: 1 }, 0.6)
      .at(t, "rs", { s: 0.5, o: 0.9 }, 0)
      .at(t, "rs", { s: 3.2, o: 0 }, 0.9, "out")
      .at(t, "w", { x: SPARK[0], y: SPARK[1], s: 0.3, o: 0 }, 0)
      .at(t + 0.1, "w", { s: 1, o: 1 }, 0.2)
      .at(t + 0.1, "w", { x: to[0], y: to[1] }, 0.75)
      .at(land, "w", { s: 0.3, o: 0 }, 0.25)
      .at(land, "rt", { x: to[0], y: to[1], s: 0.5, o: 0.9 }, 0)
      .at(land, "rt", { s: 4, o: 0 }, 0.9, "out");
    return land;
  };
  let c = idea(1.0, [250, -10]);
  sc.at(c, "main", { w: 330 }, 0.9).at(
    c,
    "right",
    { x: 130, w: 240, o: 1 },
    0.9,
  );
  c = idea(3.2, [-40, 160]);
  sc.at(c, "main", { h: 280 }, 0.9).at(
    c,
    "bottom",
    { y: 64, h: 186, o: 1 },
    0.9,
  );
  c = idea(5.4, [-300, 20]);
  sc.at(c, "side", { w: 70 }, 0.9)
    .at(c, "main", { x: -290, w: 410 }, 0.9)
    .at(c, "bottom", { x: -290, w: 410 }, 0.9);
  c = idea(7.6, [-335, 130]);
  sc.at(c, "side", { h: 230 }, 0.8).at(c, "tool", { y: 14, h: 236, o: 1 }, 0.8);
  c = idea(9.8, [0, -60]);
  sc.at(c, "right", { x: -290, w: 240 }, 1.0)
    .at(c, "main", { x: -40 }, 1.0)
    .at(c, "bottom", { x: -40 }, 1.0);
  c = idea(12.0, [40, 0]);
  sc.at(c, "bottom", { y: 250, h: 0, o: 0 }, 0.8)
    .at(c, "tool", { y: 250, h: 0, o: 0 }, 0.8)
    .at(c, "side", { w: SIDE.w, h: SIDE.h }, 0.9)
    .at(c, "right", { x: 370, w: 0, o: 0 }, 0.9)
    .at(c, "main", { x: MAIN.x, w: MAIN.w, h: MAIN.h }, 0.9);
  return { back: disc(`${prefix}g1`), front: b, timeline: sc };
}
