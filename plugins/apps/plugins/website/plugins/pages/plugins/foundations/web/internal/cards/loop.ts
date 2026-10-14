import { R } from "../kit/draw";
import { defineCard } from "../kit/types";
import "./loop.css";

const STEPS = [
  "Task",
  "Agent",
  "Worktree",
  "Build",
  "Check",
  "Push",
  "Main rebuilds",
];
const N = STEPS.length;
const cx = 151;
const cy = 118;
const r = 100;
const BW = 82;
const BH = 26;
const ang = (i: number) => -Math.PI / 2 + (i / N) * Math.PI * 2;
const pt = (i: number): [number, number] => [
  +(cx + r * Math.cos(ang(i))).toFixed(1),
  +(cy + r * Math.sin(ang(i))).toFixed(1),
];
// the arc from step a to step b, clockwise
const arc = (a: number, b: number) => {
  const [x0, y0] = pt(a);
  const [x1, y1] = pt(b);
  return `M${x0} ${y0} A${r} ${r} 0 ${(b - a) / N > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
};
const rangeList = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const range = (from: number, to: number) => rangeList(from, to).join(" ");

/**
 * The loop: a task becomes an agent, which works in its own worktree, builds, checks and pushes, and main rebuilds
 * the app that runs the loop. A progress arc draws round the ring BEHIND the steps (never over them), the current step
 * is lit and the ones behind it keep an accent outline; the last state closes the circle and the app in the middle
 * shows its new version.
 */
export const loopCard = defineCard({
  states: N + 1, // state i < N: step i is on · N: the circle closes and the app updates
  autoplay: {
    seq: rangeList(0, N + 1),
    every: [...Array.from({ length: N }, () => 1050), 2600],
    lead: 700,
  },
  render: (k) => {
    let s = `<circle cx="${cx}" cy="${cy}" r="${r}" class="k-ink k-faint"/>`;
    // the arc so far: what earlier states drew stays still, only the newest stretch draws itself
    for (let st = 1; st <= N; st++) {
      s +=
        `<g data-in="${st}" data-still>` +
        (st > 1 ? `<path d="${arc(0, st - 1)}" class="lp-arc"/>` : "") +
        `<path d="${arc(st - 1, st === N ? N - 0.002 : st)}" pathLength="100" class="lp-arc lp-seg"/></g>`;
    }
    // the steps sit on top of the arc: lit while current, accent outline once the arc has passed them
    STEPS.forEach((t, i) => {
      const [x, y] = pt(i);
      const rect = (cls: string) =>
        `<rect x="${x - BW / 2}" y="${y - BH / 2}" width="${BW}" height="${BH}" rx="${R.md}" class="${cls}"/>`;
      s +=
        `<g class="lp-step" data-on="${range(i + 1, N + 1)}">${rect("k-box")}${k.text(x, y + 4, t, "k-tb")}</g>` +
        `<g class="lp-now" data-in="${i}">${rect("k-lit")}${k.text(x, y + 4, t, "k-tb k-ta")}</g>`;
    });
    // the app the loop runs in, updated when the circle closes
    s +=
      `<g data-in="${range(0, N)}">${k.text(cx, cy + 4, "the app", "k-tb k-mute")}</g>` +
      `<g class="lp-app" data-in="${N}"><rect x="${cx - 48}" y="${cy - 19}" width="96" height="38" rx="${R.md}" class="k-lit"/>` +
      k.text(cx, cy - 2, "the app", "k-tb k-ta") +
      k.text(cx, cy + 11, "new version live", "k-ts k-ta") +
      `</g>`;
    return k.svg(cy + r * Math.sin(ang(3)) + BH / 2 + 4, s);
  },
});
