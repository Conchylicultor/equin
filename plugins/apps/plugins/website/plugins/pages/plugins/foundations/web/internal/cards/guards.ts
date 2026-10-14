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
const GX = 80;
const GW = 100;
const WX = 204;
const WW = 98;
const H = 36;
const Y0 = 6;
const STEP = 50;
// states: lane i plays 3i (sent) · 3i+1 (approved, and passed on) · 3i+2 (arrived); REST: nothing lit, a breath
// before the loop starts again. The two moving beats are held exactly as long as a link draws (--k-draw), so each
// arrow starts as the one before it lands.
const REST = 9;
const beats = (i: number, from: number) =>
  [0, 1, 2]
    .filter((b) => b >= from)
    .map((b) => 3 * i + b)
    .join(" ");

/**
 * Checks, lint & guards: three complementary guards, each watching a different part of an agent's work — the
 * commands it runs, the code it writes, the codebase as a whole. Each guard sits between the agent and what it
 * guards. A lane tells one story in one motion: the agent sends its work to the guard; as it lands the guard approves
 * it and it goes straight on to what it guards. The lanes play one after another.
 */
export const guardsCard = defineCard({
  states: 10,
  start: REST,
  autoplay: {
    seq: [REST, 0, 1, 2, 3, 4, 5, 6, 7, 8],
    every: [400, 550, 550, 500, 550, 550, 500, 550, 550, 1400],
    lead: 900,
  },
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
      const bx = GX + GW - 3;
      const by = y + 3;
      // sent: the work leaves the agent for the guard
      s += k.link(AW, cy, GX, cy, {
        dir: "h",
        on: beats(i, 0),
        fade: "dim",
        send: true,
      });
      // approved: the guard lights and stamps its check
      s +=
        `<g data-on="${beats(i, 1)}" class="k-sw k-sw-dim">` +
        box(GX, GW, y, "shield", gate, gateSub) +
        `</g>` +
        `<g data-in="${beats(i, 1)}"><circle cx="${bx}" cy="${by}" r="7" class="k-accf"/>` +
        `<path d="M${bx - 3.2} ${by} l2.2 2.2 l4.2 -4.6" class="k-inv"/></g>`;
      // passed on: the work leaves the guard as soon as it is approved, and lights what it reaches
      s +=
        k.link(GX + GW, cy, WX, cy, {
          dir: "h",
          on: beats(i, 1),
          fade: "dim",
          send: true,
        }) +
        `<g data-on="${beats(i, 2)}" class="k-sw k-sw-dim">` +
        box(WX, WW, y, icon, what, whatSub) +
        `</g>`;
    });
    return k.svg(Y0 + 2 * STEP + H + 2, s);
  },
});
