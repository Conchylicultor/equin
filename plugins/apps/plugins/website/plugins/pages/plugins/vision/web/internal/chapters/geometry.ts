import { n1, type Pt, type Rect } from "../kit/math";

/**
 * Where each frame sits inside the next: IN[k] places frame k in frame k + 1 —
 * its centre `o` (in frame k + 1's units) and `r`, how many times smaller it is.
 * Every frame is drawn in a 1000 × 1000 box centred on (0, 0).
 */
export const SPARK: Pt = [352, -255]; // the idea's spark — the app's improve button, in its title bar (frame 1 units)

export const IN: readonly { o: Pt; r: number }[] = [
  { o: SPARK, r: 6 }, // the idea is the spark in the app's title bar
  { o: [0, 12.8], r: 1.25 }, // the app is the window chapter 2's apps play in
  { o: [0, -20], r: 2.4 }, // that window, in the middle of the OS's desktop
  { o: [0, 0], r: 4.5 }, // your OS among other people's
  { o: [-60, 40], r: 5 }, // everyone's, one city of lights on the earth
];

/** Frame k's units → frame k + 1's. */
export const into = (k: number, x: number, y: number): Pt => {
  const p = IN[k]!;
  return [p.o[0] + x / p.r, p.o[1] + y / p.r];
};

/** Frame 1's app at rest: its two panes (frame 1 units). */
export const SIDE = { x: -370, y: -226, w: 150, h: 476 };
export const MAIN = { x: -210, y: -226, w: 580, h: 476 };

/** The app's content area (both panes of frame 1 at rest), in frame 2 units: where chapter 2 plays. */
export const CA: Rect = (() => {
  const a = into(1, SIDE.x, SIDE.y);
  const b = into(1, MAIN.x + MAIN.w, MAIN.y + MAIN.h);
  return { x: n1(a[0]), y: n1(a[1]), w: n1(b[0] - a[0]), h: n1(b[1] - a[1]) };
})();

/** A frame 2 rect, in frame 3 units. */
export function to3(r: Rect): Rect {
  const a = into(2, r.x, r.y);
  return { x: a[0], y: a[1], w: r.w / IN[2]!.r, h: r.h / IN[2]!.r };
}
