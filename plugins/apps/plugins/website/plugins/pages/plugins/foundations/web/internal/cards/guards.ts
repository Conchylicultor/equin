import type { LucideName } from "../kit/draw";
import { defineCard } from "../kit/types";

const LANES: readonly (readonly [
  LucideName,
  string,
  string,
  string,
  string,
])[] = [
  ["terminal", "Commands", "it runs", "Guards", "before running"],
  ["code", "Code", "it writes", "Lint", "as it is written"],
  ["layers", "Codebase", "as a whole", "Checks", "on every build"],
];
const AW = 56;
const WX = 80;
const WW = 98;
const GX = 202;
const GW = 100;
const H = 36;
const Y0 = 6;
const STEP = 50;

/**
 * Checks, lint & guards: three complementary guards, each watching a different part of an agent's work — the
 * commands it runs, the code it writes, the codebase as a whole. Each lane lights in turn, then all three together.
 */
export const guardsCard = defineCard({
  states: 4, // lane i lit · 3: all three together
  autoplay: { seq: [0, 1, 2, 3], every: [1700, 1700, 1700, 2600], lead: 900 },
  render: (k) => {
    const bh = Y0 + 2 * STEP + H - Y0;
    let s =
      `<rect x="0" y="${Y0}" width="${AW}" height="${bh}" rx="${k.R.lg}" class="k-box"/>` +
      k.icon("bot", AW / 2, Y0 + bh / 2 - 8, 18) +
      k.text(AW / 2, Y0 + bh / 2 + 14, "Agent", "k-tb");
    const box = (
      x: number,
      w: number,
      y: number,
      icon: LucideName,
      title: string,
      sub: string,
    ) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${H}" rx="${k.R.md}" class="k-box"/>` +
      k.icon(icon, x + 15, y + H / 2, 13) +
      k.text(x + 28, y + 15, title, "k-tb", "start") +
      k.text(x + 28, y + 27, sub, "k-ts k-mute", "start");
    LANES.forEach(([icon, what, whatSub, gate, gateSub], i) => {
      const y = Y0 + i * STEP;
      const cy = y + H / 2;
      // one lane, drawn once: it lights (and its links redraw) in its own state and in "all three"
      s +=
        `<g data-on="${i} 3" class="k-sw k-sw-dim">` +
        k.link(AW, cy, WX, cy, { dir: "h" }) +
        box(WX, WW, y, icon, what, whatSub) +
        k.link(WX + WW, cy, GX, cy, { dir: "h", delay: 0.25 }) +
        box(GX, GW, y, "shield", gate, gateSub) +
        `</g>`;
    });
    return k.svg(Y0 + 2 * STEP + H + 2, s);
  },
});
