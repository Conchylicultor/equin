import { defineCard } from "../kit/types";
import "./isolation.css";

/**
 * Crash isolation: one section inside the calendar (a single day) crashes and shows its error in place; the other
 * days of the same calendar keep working. States: 0 working · 1 Wednesday crashed · 2 handed to an agent.
 */
export const isolationCard = defineCard({
  states: 3,
  autoplay: { seq: [0, 1, 2], every: [1800, 2600, 2400] },
  render: (k) => {
    let s =
      k.window(4, 4, 294, 132, "Calendar") +
      k.text(14, 45, "October", "k-tl", "start");
    const EV = [
      [78, 14],
      [96, 18],
      [80, 26],
      [100, 14],
      [84, 20],
    ] as const;
    const CRASH = 2;
    (["Mon", "Tue", "Wed", "Thu", "Fri"] as const).forEach((d, i) => {
      const x = 12 + i * 56;
      const cx = x + 26;
      const [y, h] = EV[i] ?? [0, 0];
      const ev = `<rect x="${x + 5}" y="${y}" width="42" height="${h}" rx="3" class="k-accf k-mute"/>`;
      if (i !== CRASH) {
        s +=
          k.box(x, 58, 52, 70, { r: k.R.sm }) +
          k.text(cx, 71, d, "k-ts k-mute") +
          ev;
        return;
      }
      // the one day that crashes, inside the calendar: the same box, lit and dashed while crashed
      s += `<g data-on="1 2" class="k-sw is-crash">${k.box(x, 58, 52, 70, { r: k.R.sm })}</g>${k.text(cx, 71, d, "k-ts k-mute")}`;
      s += `<g data-in="0">${ev}</g>`;
      s += `<g data-in="1">${k.icon("alert", cx, 86, 12, "k-ta")}${k.text(cx, 103, "Crashed", "k-ts")}${k.button(cx, 107, 36, "fix", "Fix")}</g>`;
      s += `<g data-in="2">${k.spinner(cx, 90, 6)}${k.text(cx, 110, "Fixing…", "k-ts k-ta")}</g>`;
    });
    return k.svg(140, s);
  },
  actions: { fix: (ctx) => ctx.go(2) },
});
